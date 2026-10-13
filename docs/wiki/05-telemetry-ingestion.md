# Telemetry Ingestion — `ingestRemote()` Deep Dive

**File:** `server/graph/GraphStore.ts`, method `ingestRemote(payload, clientIp?)`

This is the most complex method in the codebase. It processes all five event types in a `TelemetryEnvelope` and merges them into the live graph state.

## The Envelope Format

```typescript
interface TelemetryEnvelope {
  targetId: string;
  events: {
    nodes:            ServiceNodeEvent[];
    edges:            DependencyEdgeEvent[];
    metrics:          { nodeId: string; snapshot: MetricSnapshot }[];
    interactions:     InteractionEvent[];
    connectionEvents: ConnectionEvent[];
  };
}
```

## Processing Order (Critical)

Events are always processed in this exact sequence:

```
nodes → edges → metrics → interactions → connectionEvents
```

Order matters because later stages reference state set by earlier ones:
- `interactions` creates or upgrades edges → edge IDs must be canonical → nodes must already exist so `normalizeId` can work correctly
- `connectionEvents` increments `edgeActivity` → the edge must exist

## Stage 1: Target Upsert

```typescript
const remoteIp = (clientIp || '').replace('::ffff:', '');
this.upsertTarget({
  targetId,
  status: 'LIVE',
  lastSeen: new Date().toISOString(),
  // Only update host if it's not a loopback (i.e., not via SSH tunnel)
  host: remoteIp && remoteIp !== '127.0.0.1' ? remoteIp : existingTarget?.host,
});
```

**Why skip loopback?** When the remote collector reaches the server through the SSH reverse tunnel, `clientIp` is `127.0.0.1`. Updating `host` to loopback would break the display and any subsequent direct HTTP probing.

## Stage 2: Node Events

```typescript
for (const node of (events.nodes || [])) {
  node.id = normalizeId(node.id);
  const existing = nodesMap.get(node.id);
  if (existing) {
    existing.status = node.status;
    existing.lastSeen = nowIso;
    if (node.metadata) existing.metadata = { ...existing.metadata, ...node.metadata };
  } else {
    nodesMap.set(node.id, { ...node, lastSeen: nowIso });
  }
}
```

**Metadata merge (spread) not replace:** The remote collector may only send a subset of metadata in a given cycle (e.g., it has the container ID but not the restart count yet). Using spread preserves fields the current batch didn't include.

**Server clock for `lastSeen`:** The collector's machine could have a clock skew of minutes. The server uses its own clock for `lastSeen` so that staleness detection (`checkTargetStaleness`) is consistent — it compares `lastSeen` against the server's own `Date.now()`.

## Stage 3: Edge Events

```typescript
for (const edge of (events.edges || [])) {
  edge.source = normalizeId(edge.source);
  edge.target = normalizeId(edge.target);
  edge.id = `${edge.source}->${edge.target}`;

  const existing = edgesMap.get(edge.id);

  if (!edge.observed) {
    // Declared-only edge: insert if absent, never overwrite
    if (!existing) edgesMap.set(edge.id, { ...edge, evidenceSources: ['compose-config'] });
    continue;
  }

  // Observed edge: merge into existing or create new
  if (existing) {
    existing.observed = true;
    if (edge.protocol) existing.protocol = edge.protocol;
    existing.lastSeen = nowIso;
    for (const src of (edge.evidenceSources || [])) {
      if (!existing.evidenceSources.includes(src)) existing.evidenceSources.push(src);
    }
  } else {
    edgesMap.set(edge.id, { ...edge, firstSeen: nowIso, lastSeen: nowIso });
  }
}
```

**Key invariant:** A declared edge is never overwritten by a subsequent declared edge. An observed edge always wins over a declared-only one. This prevents the graph from losing runtime evidence when a new discovery cycle re-sends the Compose-derived declared deps.

## Stage 4: Metric Events

Two writes per metric event:

```typescript
for (const { nodeId, snapshot } of (events.metrics || [])) {
  const nId = normalizeId(nodeId);
  
  // 1. Push to MetricStore ring buffer (for /api/nodes/:id/metrics history)
  this.metricStore.push(nId, snapshot);

  // 2. Update node.metrics inline (for immediate getGraph() availability)
  const node = nodesMap.get(nId);
  if (node) {
    node.metrics = {
      cpu:           snapshot.cpu !== undefined ? Math.round(snapshot.cpu * 10) / 10 : node.metrics?.cpu,
      memory:        snapshot.memory,
      memoryPercent: snapshot.memoryPercent,
      networkRx:     snapshot.networkRx,
      networkTx:     snapshot.networkTx,
      latency:       null,      // Populated from interactions, not Docker stats
      requestRate:   null,
      errorRate:     null,
    };
  }
}
```

**Why two writes?** `MetricStore` is the historical store. `node.metrics` is the "latest value" fast path. Without the inline update, `getGraph()` would need to query MetricStore for every node on every broadcast — that's O(N) MetricStore lookups vs. O(1) already-on-the-node reads.

**Why is `latency` null here?** Docker stats don't know about HTTP latency. That data comes from log parsing (`events.interactions`). Setting it null here prevents stale values from a previous cycle from lingering.

**CPU rounding:** `Math.round(cpu * 10) / 10` → one decimal place. Avoids `23.456789%` in the UI.

## Stage 5: Interaction Events (HTTP Log Data)

These are the richest events, parsed from container access logs:

```typescript
for (const e of (events.interactions || [])) {
  e.source = normalizeId(e.source);
  e.target = normalizeId(e.target);

  // Null-coalesce optional fields
  e.latencyMs  = e.latencyMs  ?? null;
  e.statusCode = e.statusCode ?? null;
  e.bytesSent  = e.bytesSent  ?? null;

  // Derive success from status code
  e.success = e.success ?? (e.statusCode === null ? null : e.statusCode < 400);

  // Push to MetricStore for edge metric aggregation
  this.metricStore.pushEvent(e);

  // Skip sentinel sources — they don't map to a real edge
  if (e.source === 'external' || e.source === 'unknown-upstream') continue;

  // Upgrade or create edge
  const edgeId = `${e.source}->${e.target}`;
  const existing = edgesMap.get(edgeId);
  const edgeType = (e.protocol === 'amqp' || e.protocol === 'rabbitmq') ? 'message' : 'http';

  if (existing) {
    existing.observed = true;
    existing.lastSeen = nowIso;
    if (!existing.evidenceSources.includes('http-log')) existing.evidenceSources.push('http-log');
    if (e.protocol) existing.protocol = e.protocol;
  } else {
    edgesMap.set(edgeId, {
      id: edgeId,
      source: e.source,
      target: e.target,
      type: edgeType,
      declared: false,
      observed: true,
      evidenceSources: ['http-log'],
      firstSeen: nowIso,
      lastSeen: nowIso,
      status: 'unknown',
      metrics: null,
    });
  }

  // Match against EndpointRegistry for per-route stats
  this.endpointRegistry.recordInteraction(e);
}
```

**AMQP/RabbitMQ detection:** If the log parser identifies a message broker protocol, the edge type is `message` instead of `http`. This affects edge visual styling in the UI.

**External traffic:** If `source === 'external'`, the HTTP event is pushed to MetricStore (so latency/error stats for the target service are still computed) but no edge is created (there's no source service node to connect from).

## Stage 6: Connection Events (TCP)

```typescript
for (const ev of (events.connectionEvents || [])) {
  ev.sourceServiceId = normalizeId(ev.sourceServiceId);
  ev.destServiceId   = normalizeId(ev.destServiceId);
}

// Save to TraceStore (disk + ring buffer)
if (events.connectionEvents?.length > 0) {
  const traceStore = this.getTraceStore(targetId);
  await traceStore.saveEvents(events.connectionEvents);

  // Real-time push to TracesView
  this.wsManager?.broadcast('trace-events', {
    targetId,
    events: events.connectionEvents
  });

  // Increment edge activity counters
  for (const ev of events.connectionEvents) {
    const key = `${ev.sourceServiceId}->${ev.destServiceId}`;
    const bucket = this.edgeActivity.get(key) ?? { count: 0, windowStart: Date.now() };
    bucket.count += 1;
    this.edgeActivity.set(key, bucket);
  }
}
```

**Real-time broadcast:** The `trace-events` WebSocket message is sent immediately during `ingestRemote()`, not on the 5-second polling interval. This gives the `TracesView` live-streaming behavior at collection-cycle resolution.

## Stage 7: Edge Status Recalculation

After all events are processed, edge statuses are recalculated based on aggregated HTTP metrics:

```typescript
for (const [edgeId, edge] of edgesMap.entries()) {
  const agg = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
  if (agg && agg.requestCount > 0) {
    edge.metrics = {
      requestCount: agg.requestCount,
      errorCount: agg.errorCount,
      errorRate: agg.errorRate,
      latency: agg.avgLatency,
    };
    if (agg.errorRate > 0.05)     edge.status = 'failed';
    else if (agg.avgLatency > 500) edge.status = 'degraded';
    else                           edge.status = 'active';
  } else if (edge.status === 'degraded' || edge.status === 'failed') {
    // No current evidence — reset stale bad status
    edge.status = edge.observed ? 'active' : 'unknown';
  }
}
```

**Stale bad status reset:** If an edge was `degraded` or `failed` but has received no HTTP interactions in the current aggregation window, the status resets to `active` (for observed edges) or `unknown`. This prevents one-time spikes from permanently marking an edge as failed.

**Edge-only evidence policy:** Edge status is computed only from data measured on that specific edge — not from the health of either endpoint node. See [06-edge-status.md](./06-edge-status.md) for the reasoning.

## Stage 8: Finalize

```typescript
this.updateTargetDiscoverySummaries();
this.scheduleSave();         // Debounced 2s disk write
this.wsManager?.broadcast('graph-update', this.getGraph());
```

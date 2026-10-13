# Node & Edge Lifecycle — Pruning, Status, Staleness

## Target Status Lifecycle

Targets move through states based on `lastSeen` — the ISO timestamp updated by any successful telemetry ingestion or HTTP ping.

```
(no lastSeen set)
     │
     │ first telemetry arrives
     ▼
   LIVE  ◄──────────────────────────────────────┐
     │                                           │
     │ no update for > 2 minutes                 │ (telemetry or ping succeeds)
     ▼                                           │
  STALE ─────────────────────────────────────────┤
     │                                           │
     │ no update for > 5 minutes                 │
     ▼                                           │
 OFFLINE ──────────────────────────────────────► ┘
```

`checkTargetStaleness()` runs every 10 seconds:
```typescript
private checkTargetStaleness() {
  const now = Date.now();
  for (const target of this.targets.values()) {
    if (!target.lastSeen) { target.status = 'NO DATA'; continue; }
    const ageMin = (now - new Date(target.lastSeen).getTime()) / 60_000;
    if (ageMin > 5)      target.status = 'OFFLINE';
    else if (ageMin > 2) target.status = 'STALE';
    else                 target.status = 'LIVE';
  }
}
```

### Two Independent Liveness Signals

**Signal 1 — Telemetry:** `ingestRemote()` calls `upsertTarget({ status: 'LIVE', lastSeen: now })`.

**Signal 2 — HTTP Ping:** `pingTargetEndpoints()` (every 10s) sends `HEAD` (fallback `GET`) to `target.baseUrl` with 3s timeout:

```typescript
private async pingTargetEndpoints() {
  for (const target of this.targets.values()) {
    if (!target.baseUrl) {
      target.endpointStatus = 'UNCONFIGURED';
      continue;
    }
    try {
      const res = await fetch(target.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      if (res.status < 500) {
        target.endpointStatus = 'REACHABLE';
        target.lastSeen = new Date().toISOString();
      } else {
        target.endpointStatus = 'UNREACHABLE';
      }
    } catch {
      target.endpointStatus = 'UNREACHABLE';
    }
  }
}
```

**Why two signals?** SSH channel exhaustion on resource-constrained EC2 instances can block all SSH commands for several minutes. Without the HTTP ping fallback, a healthy target with a reachable HTTP endpoint would transition to STALE/OFFLINE just because the SSH pipeline stalled.

---

## Node Pruning — Ghost Prevention

### The Problem

A container restart creates a new container ID. The old node (with the old container ID in `metadata.containerId`) has no more telemetry coming in — but it stays in the graph forever since nodes were previously only upserted, never deleted.

Result: dead "ghost" nodes that show stale CPU/memory and make the graph misleading.

### The Solution

`pruneStaleNodes()` runs every 10 seconds. Any node with `lastSeen` older than **15 minutes** is removed.

```typescript
private static readonly STALE_NODE_MS = 900_000; // 15 minutes

private pruneStaleNodes() {
  const now = Date.now();
  for (const [targetId, nodesMap] of this.nodesByTarget.entries()) {
    const removedIds = new Set<string>();

    for (const [id, node] of nodesMap.entries()) {
      const lastSeen = node.lastSeen ? new Date(node.lastSeen).getTime() : 0;
      const age = lastSeen === 0 ? Infinity : now - lastSeen;
      if (age > GraphStore.STALE_NODE_MS) {
        nodesMap.delete(id);
        this.metricStore.deleteNode(id);   // free ring-buffer memory
        removedIds.add(id);
      }
    }

    // Cascade: remove edges that reference pruned nodes
    const edgesMap = this.edgesByTarget.get(targetId);
    if (edgesMap && removedIds.size > 0) {
      for (const [edgeId, edge] of edgesMap.entries()) {
        if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
          edgesMap.delete(edgeId);
          this.edgeActivity.delete(edgeId);  // ← previously a memory leak
        }
      }
    }
  }
}
```

### Why 15 Minutes?

**SSH channel exhaustion** on `t2.micro`/`t3.micro` instances has been observed to stall all SSH commands for 3–8 minute windows. If pruning used the same 5-minute threshold as `OFFLINE`, every target's nodes would be wiped the moment it went `OFFLINE` — even though the target typically self-recovers.

The 15-minute grace window means:
- A target can go `OFFLINE` (5 min) and recover → nodes are still there, re-confirmed on next discovery
- Only genuinely dead containers (not seen for 15+ minutes) are pruned

### Load-Time Grace Period

When `loadFromDisk()` runs at startup, nodes that don't have a `lastSeen` field (from an older data format version) receive the current timestamp:

```typescript
if (!node.lastSeen) node.lastSeen = new Date().toISOString();
```

This gives them the full 15-minute grace window before being eligible for pruning, rather than being treated as "infinitely stale" and immediately removed.

### Memory Leak Fix: `edgeActivity` Cleanup

Before the fix: `pruneStaleNodes()` deleted nodes and edges from their Maps, but never cleaned up the corresponding `edgeActivity` entries. Over time (days of uptime), `edgeActivity` accumulated entries for edges that had been deleted months ago.

After the fix: `this.edgeActivity.delete(edgeId)` is called for every edge whose source or target node was pruned.

---

## Edge Status — Per-Edge Evidence Only

### Design Decision

Edge status is computed **only** from HTTP metrics measured on that specific edge. A node with 90% CPU does **not** make all connected edges show as `degraded`.

**Why?** We only have latency/error data for edges where gateway or service logs are parseable. Applying a node's resource pressure to its edges would be speculation — the node might be stressed from a batch job with nothing to do with HTTP traffic.

### Thresholds

```typescript
// Applied in ingestRemote() after MetricStore aggregation:
if (agg.errorRate > 0.05)      edge.status = 'failed';    // >5% errors
else if (agg.avgLatency > 500) edge.status = 'degraded';  // >500ms average
else                            edge.status = 'active';

// No evidence? Reset stale bad status:
if (!agg || agg.requestCount === 0) {
  edge.status = edge.observed ? 'active' : 'unknown';
}
```

### Stale Status Reset

If an edge was previously `failed` but the current aggregation window has no HTTP data (e.g., traffic stopped), the status resets. This prevents a one-time error spike from permanently marking an edge as failed after traffic normalizes.

---

## Node Status Mapping

Node status is derived from container state in the remote collector:

| Container state | Node `status` |
|---|---|
| `running` + CPU < 80% + Memory < 85% | `healthy` |
| `running` + CPU ≥ 80% OR Memory ≥ 85% | `degraded` |
| `exited` or `dead` | `critical` |
| `created`, `paused`, `restarting` | `unknown` |
| Never received telemetry | `unknown` |

The thresholds are set in the remote collector's `determineStatus()` function. They can be adjusted if different services have different normal operating ranges.

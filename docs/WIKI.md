# Microservice Mapper — Complete System Wiki & Operational Reference

This wiki is the authoritative deep-dive documentation for every design decision, subsystem, data model, and operational procedure in Microservice Mapper. It is maintained alongside the codebase and reflects the actual implementation.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Project Structure](#2-project-structure)
3. [The Canonical ID System](#3-the-canonical-id-system)
4. [GraphStore — Design & Internals](#4-graphstore--design--internals)
5. [Telemetry Ingestion Pipeline — ingestRemote()](#5-telemetry-ingestion-pipeline--ingestremote)
6. [Target Lifecycle & Staleness Detection](#6-target-lifecycle--staleness-detection)
7. [Node Pruning — Ghost Prevention](#7-node-pruning--ghost-prevention)
8. [Edge Activity & Heat Maps](#8-edge-activity--heat-maps)
9. [Edge Status — Per-Edge-Only Evidence](#9-edge-status--per-edge-only-evidence)
10. [Persistence — Debounced Disk Writes](#10-persistence--debounced-disk-writes)
11. [EndpointDiscoveryEngine — SSH Topology Discovery](#11-endpointdiscoveryengine--ssh-topology-discovery)
12. [Remote Collector — Telemetry Sources](#12-remote-collector--telemetry-sources)
13. [WebSocketManager — Broadcast & Terminal](#13-websocketmanager--broadcast--terminal)
14. [RCA Engine — Scoring Algorithm](#14-rca-engine--scoring-algorithm)
15. [IncidentManager — Lifecycle](#15-incidentmanager--lifecycle)
16. [TraceStore — TCP Connection Storage](#16-tracestore--tcp-connection-storage)
17. [MetricStore — Time-Series Storage](#17-metricstore--time-series-storage)
18. [ML Anomaly Pipeline — Internals](#18-ml-anomaly-pipeline--internals)
19. [Frontend — useGraphData Hook](#19-frontend--usegraphdata-hook)
20. [Frontend — Layout System](#20-frontend--layout-system)
21. [Frontend — Edge Visualization Semantics](#21-frontend--edge-visualization-semantics)
22. [Frontend — Terminal Multiplexing](#22-frontend--terminal-multiplexing)
23. [Traffic Controller & Experiments](#23-traffic-controller--experiments)
24. [API Routes — Full Reference](#24-api-routes--full-reference)
25. [WebSocket Protocol](#25-websocket-protocol)
26. [Configuration Variables — All Sources](#26-configuration-variables--all-sources)
27. [Data Files Reference](#27-data-files-reference)
28. [Troubleshooting Runbook](#28-troubleshooting-runbook)
29. [Adding a New Target — Step-by-Step](#29-adding-a-new-target--step-by-step)
30. [Known Bugs & Gotchas](#30-known-bugs--gotchas)

---

## 1. System Overview

Microservice Mapper is a **zero-instrumentation observability platform** for Docker-based microservices. It discovers, monitors, and visualizes distributed systems without code changes to the observed applications.

**What the system does:**
- Connects to remote EC2 instances via SSH
- Discovers topology from Docker Compose files and running containers
- Collects telemetry: CPU/memory metrics, HTTP access logs, TCP connection events
- Builds a live dependency graph combining declared architecture + runtime observations
- Visualizes the graph in a 2D/3D interactive UI
- Runs unsupervised anomaly detection (Python sidecar, optional)
- Performs rule-based root cause analysis when anomalies or failures are detected

**What it explicitly is NOT:**
- A distributed tracing system (no OpenTelemetry/Zipkin spans)
- An APM tool (no bytecode instrumentation)
- A log aggregation platform (logs are parsed for HTTP requests only, not stored long-term)
- Real-time per-request visibility (TCP connection sampling at 5s intervals misses short-lived connections)

---

## 2. Project Structure

```
microservice-mapper/
├── server/                     # Node.js/Express backend (port 3001)
│   ├── index.ts                # Entry point & startup orchestration
│   ├── config.ts               # All env-driven configuration
│   ├── api/
│   │   ├── routes.ts           # All REST endpoints (~774 lines)
│   │   └── websocket.ts        # WebSocket broadcast + terminal multiplexer
│   ├── graph/
│   │   ├── GraphStore.ts       # Central state store (708 lines, most critical file)
│   │   └── GraphAnalytics.ts   # Graph centrality/health computations
│   ├── discovery/
│   │   └── EndpointDiscoveryEngine.ts  # SSH-based per-target TargetAgent (503 lines)
│   ├── collectors/
│   │   ├── BaseCollector.ts
│   │   ├── DockerCollector.ts  # Docker API wrapper
│   │   ├── SockShopAdapter.ts  # Sock Shop-specific discovery
│   │   └── VertikalAdapter.ts  # Vertikal-specific discovery
│   ├── rca/
│   │   ├── RCAEngine.ts        # Scoring algorithm (203 lines)
│   │   ├── IncidentManager.ts  # Incident lifecycle & deduplication
│   │   ├── TemporalAnalyzer.ts # Timeline construction
│   │   ├── ExplanationEngine.ts # Natural-language narrative generation
│   │   └── AnomalyDetector.ts  # ML score reader integration
│   ├── traces/
│   │   ├── TraceStore.ts       # Per-target TCP event storage
│   │   └── TraceRouter.ts      # REST + WS routes for trace data
│   ├── telemetry/
│   │   └── MetricStore.ts      # Ring-buffer time-series + edge metric aggregation
│   ├── traffic/
│   │   ├── TrafficController.ts   # Scenario execution
│   │   ├── ExperimentManager.ts   # Experiment lifecycle
│   │   └── ExperimentStore.ts     # JSON persistence
│   ├── registry/
│   │   └── EndpointRegistry.ts    # Per-route HTTP observability tracking
│   └── models/                    # TypeScript interfaces (ServiceNode, DependencyEdge, etc.)
│
├── client/                     # React 19 + Vite 8 frontend (port 5173)
│   └── src/
│       ├── App.tsx             # Root orchestrator + all UI state (465 lines)
│       ├── hooks/
│       │   └── useGraphData.ts # WebSocket + HTTP data hook (189 lines)
│       ├── components/         # 25+ components
│       │   ├── 3d/             # Three.js scene (Scene3D, Node3D, Edge3D, layouts)
│       │   └── ...
│       ├── types/index.ts      # Client-side TypeScript interfaces
│       └── styles/             # CSS
│
├── remote-collector/
│   └── index.ts               # Standalone Node.js collector (510 lines)
│
├── ml/                        # Python anomaly detection pipeline
│   ├── collector.py           # Polls /api/graph → metrics_raw.csv
│   ├── preprocess.py          # Feature engineering + normalization
│   ├── train.py               # IsolationForest training
│   ├── score.py               # Live scoring loop
│   └── data/                  # latest_scores.json (read by server)
│
├── traffic-gen/               # HTTP traffic scenario runner
├── data/                      # Runtime state files (auto-created)
│   ├── graph_db.json          # Persisted graph state
│   ├── remote_config.json     # Target SSH configurations
│   └── traces_*.json          # Per-target TCP connection events
└── package.json               # Root: dev script + install:all
```

---

## 3. The Canonical ID System

### Why It Exists

Without a canonical ID format, the same service is described differently by different subsystems:
- Docker Compose parser: `sock-shop-catalogue`
- Remote collector (container name): `sockshop_catalogue_1`
- Compose label: `catalogue`

This causes ID mismatches where metrics from one subsystem don't attach to the node created by another — resulting in ghost nodes, missing metrics, and broken edges.

### The Format

| Entity | Format | Example |
|---|---|---|
| Node ID | `${targetId}:${serviceName}` | `sock-shop:catalogue` |
| Edge ID | `${sourceNodeId}->${targetNodeId}` | `sock-shop:front-end->sock-shop:catalogue` |
| Route ID | `${targetId}:${service}/http-${port}/${METHOD}${path}` | `sock-shop:front-end/http-80/GET/catalogue` |

### The `normalizeId()` Function

Located in `GraphStore.ingestRemote()`. Called on every ID before any lookup:

```typescript
const normalizeId = (rawId: string) => {
  if (!rawId || rawId === 'external' || rawId === 'unknown-upstream') return rawId;
  // Strip the targetId prefix if it exists with any separator
  const clean = rawId.replace(new RegExp(`^${targetId}[-:/]`), '');
  return `${targetId}:${clean}`;
};
```

`external` and `unknown-upstream` are sentinel values that are never normalized — they represent traffic from outside the monitored cluster.

---

## 4. GraphStore — Design & Internals

**File:** `server/graph/GraphStore.ts`

The GraphStore is the single source of truth for all graph state. No other module keeps authoritative copies of nodes, edges, or targets.

### Constructor Sequence

```
new GraphStore(wsManager)
  1. Store wsManager reference
  2. Set storagePath = "data/graph_db.json"
  3. new EndpointDiscoveryEngine(...)  ← wired with callbacks into GraphStore
  4. loadFromDisk()                    ← restore previous state
  5. loadTargetsFromConfig()           ← load remote_config.json SSH configs
  6. discoveryEngine.discoverAll()     ← initial SSH discovery pass
  7. setInterval(10_000):
       ├── checkTargetStaleness()
       ├── pruneStaleNodes()
       ├── pingTargetEndpoints()
       ├── updateTargetDiscoverySummaries()
       └── broadcast('graph-update', getGraph())
```

### Internal Maps

All state is held in `Map` structures (not plain objects) to avoid prototype pollution and enable O(1) lookup by ID:

```typescript
public targets       = new Map<string, Target>();
public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();
private edgeActivity = new Map<string, { count: number; windowStart: number }>();
private traceStores  = new Map<string, TraceStore>();
private anomalyScoresCache: { mtimeMs: number; data: Record<string, any> } | null = null;
```

### Helper Accessors

```typescript
private getTargetNodes(targetId): Map<string, ServiceNode>
private getTargetEdges(targetId): Map<string, DependencyEdge>
```

Both create the inner map lazily on first access. This prevents null checks throughout the codebase.

### `getGraph()` — Read Path

Called on every WebSocket broadcast and every REST `/api/graph` request:

```typescript
getGraph() {
  const allNodes = [...all nodesByTarget values flattened...]
  const allEdges = [...all edgesByTarget values flattened...]

  // Attach ML anomaly scores (mtime-cached)
  const scores = this.readAnomalyScores();
  for (const node of allNodes) {
    const s = scores[node.id];
    if (s) node.analytics = { ...node.analytics, anomalyScore: s.anomaly_score, anomalyPersistent: s.persistent };
  }

  // Convert raw event counts to activity rates
  this.applyEdgeActivity(allEdges);

  return { nodes: allNodes, edges: allEdges, targets: [...targets.values()] };
}
```

---

## 5. Telemetry Ingestion Pipeline — `ingestRemote()`

**File:** `server/graph/GraphStore.ts`, method `ingestRemote(payload, clientIp?)`

The most complex method in the system. Called by:
- `POST /api/ingest` (from remote-collector)
- `EndpointDiscoveryEngine.onTelemetryCollected` callback (from SSH-based collection)

### Processing Order (Important)

Events are processed in strict order: `nodes → edges → metrics → interactions → connectionEvents`. This order matters because later stages reference state set by earlier ones (e.g., interactions try to upgrade edges that were set in the edges phase).

### Stage 1: Target Upsert

```typescript
this.upsertTarget({
  targetId,
  status: 'LIVE',
  lastSeen: new Date().toISOString(),
  host: remoteHost !== 'unknown' ? remoteHost : existingTarget?.host,
  // ...
});
```

The remote IP extracted from `clientIp` (cleaned of IPv6 prefix `::ffff:`) becomes the `host`. If the IP is `127.0.0.1` (SSH tunnel), the existing host is preserved.

### Stage 2: Node Events

```typescript
for (const node of events.nodes) {
  node.id = normalizeId(node.id);
  const existing = nodesMap.get(node.id);
  if (existing) {
    existing.status = node.status;
    existing.lastSeen = nowIso;
    if (node.metadata) existing.metadata = { ...existing.metadata, ...node.metadata };
  } else {
    node.lastSeen = nowIso;
    nodesMap.set(node.id, node);
  }
}
```

**Key design decisions:**
- Metadata is **merged** (spread), not replaced — preserves fields the collector didn't send in this batch
- `lastSeen` always gets the server's clock (not the collector's), avoiding clock skew issues

### Stage 3: Edge Events

Observed edges take priority over declared-only edges:
```typescript
if (!edge.observed) {
  // Only insert if not already present — never overwrite observed data with declared-only
  if (!existing) edgesMap.set(edge.id, edge);
  continue;
}
// For observed edges: merge into existing or insert new
```

### Stage 4: Metric Events

Two writes happen per metric event:
1. `MetricStore.push(nodeId, snapshot)` → ring buffer for historical queries
2. Direct `node.metrics = {...}` update → immediately visible in `getGraph()`

The direct update means the UI sees fresh metrics on the next broadcast without needing to query `MetricStore`.

CPU and memory percent are rounded to 1 decimal place to avoid noisy floating-point values in the UI.

### Stage 5: Interaction Events (HTTP)

These are the richest events, from log parsing in the remote collector:

```typescript
e.source = normalizeId(e.source);
e.target = normalizeId(e.target);
e.success = e.success ?? (e.statusCode === null ? null : e.statusCode < 400);
this.metricStore.pushEvent(e);

// Upgrade or create edge
const edgeId = `${e.source}->${e.target}`;
const existing = edgesMap.get(edgeId);
if (existing) {
  existing.observed = true;
  existing.protocol = e.protocol || existing.protocol;
  if (!existing.evidenceSources.includes('http-log')) existing.evidenceSources.push('http-log');
} else {
  edgesMap.set(edgeId, {
    type: e.protocol === 'amqp' || e.protocol === 'rabbitmq' ? 'message' : 'http',
    declared: false,
    observed: true,
    evidenceSources: ['http-log'],
    ...
  });
}
```

**Protocol detection**: AMQP/RabbitMQ protocol → `message` type edge. All other protocols → `http` type.

**External traffic**: Interactions where `source === 'external'` or `source === 'unknown-upstream'` are pushed to MetricStore but do NOT create edges (these sentinel values are skipped in the edge creation check).

### Stage 6: Connection Events (TCP)

```typescript
// Save to disk + ring buffer
traceStore.saveEvents(events.connectionEvents);

// Broadcast real-time to TracesView
wsManager.broadcast('trace-events', { targetId, events: events.connectionEvents });

// Increment activity counter
for (const ev of events.connectionEvents) {
  const key = `${normalizeId(ev.sourceServiceId)}->${normalizeId(ev.destServiceId)}`;
  const bucket = this.edgeActivity.get(key) ?? { count: 0, windowStart: Date.now() };
  bucket.count += 1;
  this.edgeActivity.set(key, bucket);
}
```

### Stage 7: Edge Status Recalculation

After all events processed, edge statuses are re-evaluated:
```typescript
for (const edge of edgesMap.values()) {
  const edgeMetrics = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
  if (edgeMetrics && edgeMetrics.requestCount > 0) {
    edge.status = errorRate > 0.05 ? 'failed'
                : latency > 500   ? 'degraded'
                                  : 'active';
  } else if (edge.status === 'degraded' || edge.status === 'failed') {
    // No current evidence — reset stale bad status
    edge.status = edge.observed ? 'active' : 'unknown';
  }
}
```

### Stage 8: Broadcast + Save

```typescript
this.updateTargetDiscoverySummaries();
this.scheduleSave();
wsManager.broadcast('graph-update', this.getGraph());
```

---

## 6. Target Lifecycle & Staleness Detection

### Status Transitions

```
(no lastSeen) → NO DATA
    ↓ (telemetry or discovery arrives)
  LIVE  ←─────────────────────────────┐
    ↓ (no update for 2+ minutes)       │
  STALE                                │ (ping succeeds OR telemetry arrives)
    ↓ (no update for 5+ minutes)       │
  OFFLINE ─────────────────────────────┘
```

### Two Independent Liveness Signals

**Signal 1 — Telemetry/Discovery:** `ingestRemote()` and `handleTopologyDiscovered()` both call `upsertTarget()` with `status: 'LIVE'` and `lastSeen: now`.

**Signal 2 — HTTP Ping:** `pingTargetEndpoints()` (every 10s) sends `HEAD` (fallback `GET`) to `target.baseUrl` with 3s timeout. If `response.status < 500`, `target.lastSeen = now`. This keeps a target `LIVE` even if the SSH telemetry pipeline stalls (which can happen with SSH channel exhaustion).

### Why Two Signals?

SSH channel exhaustion on resource-constrained EC2 instances can stall ALL SSH commands for several minutes. Without the HTTP ping fallback, a perfectly-healthy target would transition to STALE/OFFLINE even though its HTTP endpoint is reachable and its containers are running.

---

## 7. Node Pruning — Ghost Prevention

**File:** `GraphStore.pruneStaleNodes()`, called every 10 seconds.

**Threshold:** `STALE_NODE_MS = 900_000` (15 minutes, private static constant)

### What Creates Ghosts

1. A container restarts with a new container ID — old node stays forever (only upserted, never deleted)
2. A discovery cycle creates a node that a metric collection cycle can't match (different name format)
3. A temporary SSH failure causes a service to be skipped for several cycles

### Pruning Logic

```typescript
private pruneStaleNodes() {
  const now = Date.now();
  for (const [targetId, nodesMap] of this.nodesByTarget.entries()) {
    const removedIds = new Set<string>();
    for (const [id, node] of nodesMap.entries()) {
      const age = node.lastSeen ? now - new Date(node.lastSeen).getTime() : Infinity;
      if (age > GraphStore.STALE_NODE_MS) {
        nodesMap.delete(id);
        this.metricStore.deleteNode(id);  // free ring-buffer memory
        removedIds.add(id);
      }
    }
    // Clean up edges referencing pruned nodes
    const edgesMap = this.edgesByTarget.get(targetId);
    if (edgesMap) {
      for (const [edgeId, edge] of edgesMap.entries()) {
        if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
          edgesMap.delete(edgeId);
          this.edgeActivity.delete(edgeId); // ← previously a memory leak
        }
      }
    }
  }
}
```

### Why 15 Minutes (Not 5)?

The target goes `OFFLINE` after 5 minutes of no telemetry. SSH channel exhaustion events of 3–8 minutes have been observed in testing. Pruning on a 5-minute clock would wipe all nodes the moment a target goes `OFFLINE` — but the target typically recovers in a few minutes. The 15-minute window gives the system room to recover and re-confirm nodes without losing graph state.

### Load-Time Grace Period

When nodes are loaded from disk on startup, nodes without a `lastSeen` field (from an older data format) receive the current timestamp. This ensures they get the full 15-minute window before being eligible for pruning, rather than being immediately deleted as "infinitely stale."

---

## 8. Edge Activity & Heat Maps

The `edgeActivity` map powers the "heat" visualization on edges — showing how busy a link is in terms of observed TCP connections.

### Accumulation

Each `connectionEvent` (from `/proc/net/tcp`) increments the counter for its edge:
```typescript
bucket.count += 1;
```

### Rate Calculation (`applyEdgeActivity`)

Called inside `getGraph()` before returning:

```typescript
const elapsedMs = Math.max(1000, now - bucket.windowStart);
const perMin = (bucket.count / elapsedMs) * 60_000;
edge.activity = {
  samplesPerMin: Math.round(perMin * 10) / 10,
  windowSec: Math.round(elapsedMs / 1000),
  lastSeen: new Date().toISOString(),
};
```

### Window Reset (Decay)

Every 2 minutes (`WINDOW_RESET_MS = 120_000`), the window resets with a **half-count carry-forward**:

```typescript
if (elapsedMs > WINDOW_RESET_MS) {
  this.edgeActivity.set(edge.id, {
    count: Math.floor(bucket.count / 2),
    windowStart: now - WINDOW_RESET_MS / 2,
  });
}
```

**Why half-count carry-forward?** If we reset to zero, the rate would snap to zero for one polling cycle every 2 minutes — creating a flickering heat display. Carrying half the count forward makes the rate decay smoothly. The midpoint reset (`now - 60_000`) gives the new window a more accurate elapsed time baseline.

### No Activity = No Field

Edges with no observations intentionally have no `activity` field in the returned graph. This distinguishes "never observed" from "measured as zero" — both are valid states but they mean different things for display purposes.

---

## 9. Edge Status — Per-Edge-Only Evidence

### Design Decision

Edge status is computed **only from data measured on that specific edge** (HTTP metrics from log parsing). A node with high CPU does **not** cause all connected edges to turn yellow/red.

**Rationale:** We only have HTTP-level latency/error data for edges where the gateway or service log is parseable. Applying a node's resource stress to its edges would be speculation — the node might be under CPU pressure from something unrelated to the edge traffic.

### Thresholds

```typescript
// In ingestRemote(), after MetricStore aggregation:
if (edgeMetrics.errorRate > 0.05)    edge.status = 'failed';    // >5% errors
else if (edgeMetrics.latency > 500)  edge.status = 'degraded';  // >500ms avg
else                                  edge.status = 'active';

// No current evidence? Reset stale bad status:
if (!edgeMetrics || edgeMetrics.requestCount === 0) {
  edge.status = edge.observed ? 'active' : 'unknown';
}
```

The stale-status reset prevents a one-time spike from leaving an edge permanently showing as `failed` after traffic normalizes.

---

## 10. Persistence — Debounced Disk Writes

### Why Debounced

A single telemetry batch can update dozens of nodes and edges. Without debouncing, each update would trigger a separate disk write — potentially 10–20 writes per second during active telemetry ingestion. At 5-second polling with 20 services, that's significant I/O.

### Implementation

```typescript
private scheduleSave(): void {
  if (this.saveTimeout) return;  // Already scheduled — don't pile up
  this.saveTimeout = setTimeout(() => {
    this.saveTimeout = null;
    this.saveToDisk();
  }, 2000);
}
```

Any number of calls to `scheduleSave()` within a 2-second window results in exactly one disk write.

### What Gets Saved

```json
{
  "targets":        { "targetId": { ...Target } },
  "nodesByTarget":  { "targetId": { "nodeId": { ...ServiceNode } } },
  "edgesByTarget":  { "targetId": { "edgeId": { ...DependencyEdge } } }
}
```

`MetricStore`, `TraceStore`, and `edgeActivity` are **not** persisted in `graph_db.json`. They start fresh on restart (TraceStore has its own per-target JSON files).

### What Is NOT Saved

- `MetricStore` ring buffers — restart fresh (history lost, current values re-populated on next telemetry)
- `edgeActivity` counters — restart at zero (heat display starts cold)
- Experiment history — saved separately in `data/experiments.json` by `ExperimentStore`

---

## 11. EndpointDiscoveryEngine — SSH Topology Discovery

**File:** `server/discovery/EndpointDiscoveryEngine.ts`

### TargetAgent Per Target

Each registered target gets a `TargetAgent` instance that owns:
- `connManager: ConnectionManager` — main SSH connection for polling
- `adHocConnManager: ConnectionManager` — separate connection for on-demand requests

**Why two connections?** SSH channels (streams) are limited per connection. A `docker logs` fetch for `InspectionPanel` that takes several seconds would block telemetry poll cycles if they share a connection. Separate connections prevent this starvation.

### Discovery Cycle

```
1. SSH: docker ps --format json
   → parse container list
   → for each: Labels['com.docker.compose.service'] || name-based derivation
   → skip 'mapper-collector' (self)

2. SSH: cat docker-compose.yml
   → parse service.depends_on
   → extract declared dependencies

3. callback: onTopologyDiscovered(targetId, services, dependencies)
   → GraphStore.handleTopologyDiscovered()
```

### Metric Collection Cycle

```
4. for each container:
   SSH: docker stats <id> --no-stream --format json
   → cpu_delta / system_delta calculation
   → memory_stats.usage / limit

5. for each container:
   SSH: docker logs <id> --since <lastCollectedTime> --timestamps
   → strip 8-byte Docker framing header
   → apply HTTP access log regex
   → emit InteractionEvent[]

6. SSH: cat /proc/net/tcp
   → filter ESTABLISHED (state: 01)
   → resolve IPs via ipToNameMap
   → emit ConnectionEvent[]

7. callback: onTelemetryCollected(targetId, envelope)
   → GraphStore.ingestRemote()
```

### Target Config

Read from `data/remote_config.json`:
```json
{
  "sock-shop": {
    "displayName": "Sock Shop AWS",
    "ec2PublicIp": "18.206.136.26",
    "sshUsername": "ubuntu",
    "sshKeyPath": "~/.ssh/sockshop-key.pem"
  }
}
```

SSH key path supports `~/` prefix (expanded via `os.homedir()`).

---

## 12. Remote Collector — Telemetry Sources

**File:** `remote-collector/index.ts`

The collector is deployed on EC2 alongside the target application. It runs as a standalone Node.js process and requires access to `/var/run/docker.sock`.

### Connection to Backend

Default: `MAPPER_URL=http://127.0.0.1:3001`

This works because the backend opens an SSH reverse tunnel:
```bash
# The server opens: -R 3001:localhost:3001
# So on EC2: 127.0.0.1:3001 → mapper backend :3001
```

The collector POSTs to `/api/ingest` with `Authorization: Bearer <INGEST_TOKEN>`.

### Service Name Derivation Priority

1. `container.Labels['com.docker.compose.service']` (set by Compose for all services — most reliable)
2. Parse `container.Names[0]`: strip `/` prefix, strip Compose project prefix, strip replica suffix

**Example parsing:**
```
"/sockshop_catalogue_1" → "catalogue"
"/docker-compose-front-end-1" → "front-end"
"/my_app_catalogue_db_1" → "catalogue-db"
```

### Node Type Detection

```typescript
function determineType(name: string, image: string): string {
  if (n.includes('db') || img.includes('mongo') || img.includes('mysql') || img.includes('postgres'))
    return 'database';
  if (n.includes('rabbitmq') || n.includes('queue'))
    return 'queue';
  if (n.includes('edge-router') || n.includes('gateway') || img.includes('traefik'))
    return 'gateway';
  if (n.includes('front-end') || n.includes('ui'))
    return 'frontend';
  return 'service';
}
```

### Docker Log Framing

Docker's `container.logs()` stream prepends an 8-byte header to each log line:
```
[stream_type: 1 byte][padding: 3 bytes][size: 4 bytes big-endian][log data]
```

The collector strips this header before applying HTTP regex parsers. Without stripping, the first 8 bytes of log lines are garbage and all regex matches fail.

### HTTP Access Log Formats

**Standard (Apache/NGINX combined):**
```regex
^([0-9.]+).*?"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"?\s+(\d+|-)?
```
Captures: `[1]` client IP, `[2]` method, `[3]` path, `[4]` status code

**JSON (Traefik, NGINX with JSON logging, Kong):**
Parses: `upstream_response_time`, `status`, `upstream_addr`, `bytes_sent`, `request_length`

All parsed interactions are tagged `evidenceSource: 'http-log'`.

### `/proc/net/tcp` Parsing

TCP connection table (IPv4) from the Linux kernel:
```
sl  local_address rem_address   st ...
0: 00000000:0050 00000000:0000 0A ...  (LISTEN)
1: 0F02A8C0:1F90 0302A8C0:C2EA 01 ...  (ESTABLISHED)
```

State `01` = ESTABLISHED. IPs are hex little-endian (e.g., `0F02A8C0` = `192.168.2.15`).

The collector builds `ipToNameMap` from `docker inspect` (container IP → service name), then maps both endpoints to service names and emits `ConnectionEvent` for each ESTABLISHED connection between known containers.

**Documented limitation:** Short-lived connections (< 5s) that open and close between polling cycles will be missed entirely.

---

## 13. WebSocketManager — Broadcast & Terminal

**File:** `server/api/websocket.ts`

### Design: Single Port for REST + WebSocket

Both the REST API and WebSocket live on the same HTTP server (port 3001). The `WebSocketServer` is attached with `{ server }` option — it upgrades HTTP connections with `Upgrade: websocket` header.

**Why not separate ports?** Simpler deployment (one port to forward, one process manager entry). NGINX can proxy both on the same virtual host via path matching.

### Broadcast

```typescript
broadcast(type: string, data: any) {
  const payload = JSON.stringify({ type, data });
  for (const client of this.wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

No fan-out queuing or backpressure — clients that are too slow to consume messages will fall behind. Acceptable for a monitoring UI where stale data is preferable to blocking the server.

### Terminal Session Management

Per-WebSocket connection, one persistent `bash` or `ssh` child process:

```typescript
// Session lifecycle:
session = spawn('bash', ['--login'])           // local
session = spawn('ssh', ['-tt', '-F', '/dev/null', '-i', keyPath, '-o',
                        'StrictHostKeyChecking=no', `${user}@${ip}`])  // remote

// Command execution:
session.stdin.write(`${cmd}\n`);
session.stdin.write(`echo ___CMD_DONE___$?\n`);
```

The `___CMD_DONE___` sentinel is echoed after each command. The stdout listener strips it from displayed output. This gives pseudo-PTY-like behavior without requiring PTY allocation.

**Session cleanup:** On WebSocket disconnect, `session.kill()` is called. On next command, if `session.killed || session.exitCode !== null || session.stdin.destroyed`, the old session is discarded and a new one is spawned.

**SSH config lookup:** If `targetId` provided in the `TERMINAL_EXEC` message, the handler reads `data/remote_config.json` to find the EC2 IP and key path automatically — no credentials in the WebSocket message.

---

## 14. RCA Engine — Scoring Algorithm

**File:** `server/rca/RCAEngine.ts`

### Trigger Condition

`analyzeIncident()` is called by `IncidentManager.evaluateTarget()` every 5 seconds. It runs if there are any nodes with `status === 'critical'` or `status === 'degraded'`, OR any anomaly records from the ML pipeline.

### Candidate Scoring (0.0 – 1.0)

For each failing node, a score is built from additive factors:

```
Factor                     | Max Score | Condition
---------------------------|-----------|------------------------------------------
Temporal Precedence        | +0.30     | node is the earliest anomalous node
Anomaly Presence           | +0.10     | node has anomaly but isn't earliest
Critical / Container Exit  | +0.35     | status === 'critical' || metadata.state === 'exited'
Degraded Status            | +0.15     | status === 'degraded'
Observed Runtime Dependency| +0.20     | any connected edge has observed === true
Declared-Only Dependency   | +0.05     | any connected edge has declared === true (no observed)
Downstream Correlation     | +0.15     | at least one downstream node is also failing
```

**Maximum possible score:** 1.10 (temporal + critical + observed + downstream). Scores above 1.0 are possible but not normalized — the ranking is relative.

### Confidence Assignment

```typescript
score >= 0.75 → 'HIGH'
score >= 0.50 → 'MEDIUM'
score >  0.00 → 'LOW'
             → 'UNKNOWN'
```

### Propagation Path

BFS from the root cause node through `observed` edges to all reachable failing nodes:

```typescript
const visited = new Set([rootCause.id]);
const queue = [rootCause.id];
const propagation: PropagationStep[] = [];

while (queue.length > 0) {
  const current = queue.shift()!;
  for (const edge of edges.filter(e => e.source === current && e.observed)) {
    const target = nodes.find(n => n.id === edge.target);
    if (target && !visited.has(target.id)) {
      propagation.push({ sourceId: current, targetId: target.id, edgeId: edge.id, ... });
      visited.add(target.id);
      if (target.status === 'critical' || target.status === 'degraded') queue.push(target.id);
    }
  }
}
```

### Evidence Collection

For each candidate, evidence items are created from:
- Container status changes (before/after state comparison)
- ML anomaly records (if `AnomalyDetector` has scores)
- Metric snapshots showing abnormal CPU/memory

### Natural Language Explanation

`ExplanationEngine.generateExplanation()` produces a structured `RCAExplanation`:
```typescript
{
  whatHappened: string,
  whenStarted: string,
  likelyRootCause: string,
  why: string,
  propagationPath: string[],
  affectedServices: string[],
  confidence: RCAConfidence,
  alternativeCandidates: { name, score, confidence }[],
  evidenceSummary: string[],
  recommendedInvestigation: string[]
}
```

---

## 15. IncidentManager — Lifecycle

**File:** `server/rca/IncidentManager.ts`

### States

```
NORMAL → INCIDENT → RECOVERING → RESOLVED
                 ↘ (new failure) INCIDENT (re-opened)
```

### Deduplication

A running incident for a target is identified by `targetId`. If `evaluateTarget()` fires again while an incident is active for the same target, the existing incident is updated (symptoms appended, confidence updated) rather than creating a duplicate.

### Suppression

Resolved incidents are not immediately deleted — they are kept in history for the `ExperimentHistoryPanel` and `RCAView` to display. The manager tracks the last N incidents per target.

---

## 16. TraceStore — TCP Connection Event Storage

**File:** `server/traces/TraceStore.ts`

### What It Is (and Isn't)

- **Is**: SSH-sampled snapshots of active TCP connections between containers
- **Is NOT**: Distributed tracing, OpenTelemetry, per-request spans, latency data

### Storage Strategy

```typescript
class TraceStore {
  private filePath: string;    // data/traces_${targetId}.json
  private recentEvents: ConnectionEvent[] = [];
  private readonly maxRecentEvents = 500;

  async saveEvents(events: ConnectionEvent[]): Promise<void> {
    // 1. Append to in-memory ring buffer (for WebSocket streaming)
    this.recentEvents.push(...events);
    if (this.recentEvents.length > 500) this.recentEvents = this.recentEvents.slice(-500);

    // 2. Load existing disk file, merge, prune >24h old, write back
    const existing = await this.loadEvents();
    const updated = [...existing, ...events];
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const filtered = updated.filter(e => e.timestamp >= oneDayAgo);
    await fs.writeFile(this.filePath, JSON.stringify(filtered, null, 2));
  }
}
```

### Lazy Initialization

`GraphStore.getTraceStore(targetId)` creates `TraceStore` instances on first access:
```typescript
getTraceStore(targetId: string): TraceStore {
  let store = this.traceStores.get(targetId);
  if (!store) {
    store = new TraceStore(targetId);
    this.traceStores.set(targetId, store);
  }
  return store;
}
```

### TracesView Distinction

`TracesView.tsx` header comment:
> This is NOT distributed tracing (no OpenTelemetry/Zipkin spans). It shows raw TCP connections between containers, captured by reading /proc/net/tcp on the remote host at collection-cycle granularity.

---

## 17. MetricStore — Time-Series Storage

**File:** `server/telemetry/MetricStore.ts`

### Ring Buffer

Per-node circular buffer of `MetricSnapshot` objects. Capacity: `config.METRIC_HISTORY_SIZE` (default 720).

At 5-second polling: 720 × 5s = **3600 seconds = 1 hour** of history per node.

### Edge Metric Aggregation

Separate from node metrics — tracks HTTP interaction events per source→target pair:

```typescript
pushEvent(interaction: InteractionEvent) {
  const key = `${interaction.source}->${interaction.target}`;
  // Accumulate: requestCount, errorCount, totalLatency, minLatency, maxLatency
}

getAggregatedEdgeMetrics(source, target): EdgeMetrics | null {
  // Returns: requestCount, errorCount, errorRate, avgLatency, minLatency, maxLatency
}
```

---

## 18. ML Anomaly Pipeline — Internals

**Directory:** `ml/`

### collector.py

Polls `GET /api/graph` every 10 seconds. Extracts `node.metrics` for all nodes. Appends to `data/metrics_raw.csv` (append-only — never truncated).

**Why not use MetricStore's history?** MetricStore only keeps ~1 hour. Training requires days/weeks of baseline data.

### preprocess.py

1. Loads `metrics_raw.csv`
2. Converts cumulative `networkRx`/`networkTx` counters to **rates** (Δbytes per second)
3. Computes per-service **z-score normalization** (mean + std per feature)
4. Saves `data/features.csv` + `data/normalization_stats.json`

### train.py

One `IsolationForest` per service that has ≥ 30 samples. Model saved as `models/<serviceId>.joblib` + metadata JSON.

**Excluding incident windows from training:**
```bash
python3 train.py --since 2026-09-17T00:00:00Z --until 2026-09-17T02:00:00Z
```

Data outside this range is used for training. The `--since/--until` range is excluded (it likely contains the failure you don't want the model to learn as "normal").

### score.py

Live loop:
1. Poll `/api/graph` for current metrics
2. Normalize using saved `normalization_stats.json`
3. Score each service with its `IsolationForest` model
4. If score exceeds threshold AND persists for N consecutive windows → write `persistent: true`
5. Write `data/latest_scores.json`

### Server Integration

```typescript
// GraphStore.readAnomalyScores() — mtime-cached
private readAnomalyScores(): Record<string, any> {
  const stat = fs.statSync(scoresPath);
  if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
    return this.anomalyScoresCache.data;  // cached — skip parse
  }
  const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}
```

File missing → `return {}` (graceful degradation, not error).

---

## 19. Frontend — `useGraphData` Hook

**File:** `client/src/hooks/useGraphData.ts`

### Responsibilities

- Initial data load: parallel `GET /api/graph` + `GET /api/status`
- WebSocket connection management + auto-reconnect
- Graph state: `nodes`, `edges`, `targets`, `status`
- Terminal state: `terminalLogs`, `sendTerminalCommand`
- `reloadGraph(targetId)` — POST to `/api/discovery/refresh` + re-fetch

### Position Preservation Logic

Critical for smooth UX — prevents nodes from jumping during metric updates:

```typescript
ws.onmessage = (event) => {
  const { nodes: newNodes, edges: newEdges, targets: newTargets } = message.data;
  setNodes(prevNodes => {
    const prevIds = new Set(prevNodes.map(n => n.id));
    const newIds  = new Set(newNodes.map(n => n.id));
    const sameNodeSet = prevIds.size === newIds.size &&
                        Array.from(newIds).every(id => prevIds.has(id));

    if (sameNodeSet && prevNodes.length > 0) {
      // Same topology — preserve positions, update data only
      return prevNodes.map(prev => {
        const updated = newNodes.find(n => n.id === prev.id);
        return updated ? { ...prev, data: updated } : prev;
      });
    } else {
      // Topology changed — recalculate layout, keep positions for existing nodes
      const layouted = calculateLayout(newNodes);
      return layouted.map(ln => {
        const prev = prevNodes.find(p => p.id === ln.id);
        return prev ? { ...ln, position: prev.position } : ln;
      });
    }
  });
};
```

### WebSocket Reconnect

```typescript
ws.onclose = () => {
  setIsConnected(false);
  setTimeout(connectWs, 3000);  // Fixed 3s delay
};
ws.onerror = () => ws.close();  // Triggers onclose → reconnect
```

No exponential backoff by design. The server is on the same host/LAN and should be available within seconds of a restart.

---

## 20. Frontend — Layout System

**Files:** `client/src/components/layouts2d.ts`, `client/src/App.tsx`

### The Layout Signature Pattern

Computing a layout (Dagre, force-directed) is expensive. `filteredNodes` and `filteredEdges` get new array references on every WebSocket poll (every 5 seconds). Naive dependency on these arrays recomputes layouts many times per second.

**Solution:** Compute a string signature that is stable across metric-only updates:

```typescript
const layoutSignature2d = useMemo(() => {
  const nodePart = filteredNodes
    .map(n => {
      const d = n.data as any;
      return `${n.id}:${d?.type || ''}:${d?.project || ''}`;
    })
    .sort()
    .join('|');
  const edgePart = filteredEdges
    .map(e => `${e.source}>${e.target}`)
    .sort()
    .join('|');
  return `${nodePart}||${edgePart}`;
}, [filteredNodes, filteredEdges]);

// Layout only recomputes when signature changes
const layoutPositions2d = useMemo(
  () => computeLayout2D(layout2d, filteredNodes, filteredEdges),
  [layout2d, layoutSignature2d]  // ← NOT filteredNodes/filteredEdges
);
```

When only `node.metrics.cpu` changes, the signature stays the same → layout doesn't recompute.

### Layout Preference Persistence

```typescript
// Load
const [layout2d, setLayout2d] = useState<Layout2DId>(() =>
  (localStorage.getItem('mm.graph.layout2d') as Layout2DId) || 'clusters'
);

// Save
useEffect(() => {
  try { localStorage.setItem('mm.graph.layout2d', layout2d); } catch { /* private mode */ }
}, [layout2d]);
```

The `try/catch` handles Safari private mode where `localStorage` throws on write.

---

## 21. Frontend — Edge Visualization Semantics

**File:** `client/src/components/DependencyEdge.tsx`

| `declared` | `observed` | `status` | Visual |
|---|---|---|---|
| `true` | `false` | any | Solid grey — declared but no runtime traffic |
| `false` | `true` | `active` | Animated cyan marching-ants |
| `true` | `true` | `active` | Animated cyan marching-ants |
| any | any | `degraded` | Animated yellow |
| any | any | `failed` | Animated red |

The `animated` prop on ReactFlow edges is set based on `edge.status === 'active'`. The visual distinction between declared/observed/both is implemented via edge stroke style and color.

**Edge thickness/opacity** is driven by `edge.activity.samplesPerMin` — higher TCP observation rate → thicker/brighter edge.

---

## 22. Frontend — Terminal Multiplexing

### Architecture

```
React App (App.tsx)
  → TerminalPanel (floating, draggable)
  → onCommandSubmit(cmd) → sendTerminalCommand(cmd, selectedProjectId)
  → useGraphData.sendTerminalCommand(cmd, targetId)
  → ws.send({ type: 'TERMINAL_EXEC', data: { cmd, targetId } })
  → WebSocketManager.handleTerminalExec(ws, { cmd, targetId })
  → bash/ssh child process (per-WS session)
  → stdout/stderr → ws.send({ type: 'TERMINAL_LOG', data: outputLine })
  → useGraphData: setTerminalLogs(prev => [...prev, message.data])
  → TerminalPanel renders new log line
```

### Dragging

The terminal panel is absolutely positioned in `App.tsx`. Dragging is implemented with raw `mousedown`/`mousemove`/`mouseup` event listeners:

```typescript
onMouseDown={(e) => {
  if (e.target !== e.currentTarget && !e.target.classList.contains('terminal-content')) {
    const startX = e.clientX - terminalPosition.x;
    const startY = e.clientY - terminalPosition.y;
    const onMouseMove = (moveEvent) => {
      setTerminalPosition({
        x: Math.max(0, Math.min(moveEvent.clientX - startX, window.innerWidth - 300)),
        y: Math.max(0, Math.min(moveEvent.clientY - startY, window.innerHeight - 40))
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMouseMove), { once: true });
  }
}}
```

The `terminal-content` class check prevents accidental drag when the user is clicking inside the terminal textarea.

---

## 23. Traffic Controller & Experiments

**Files:** `server/traffic/TrafficController.ts`, `ExperimentManager.ts`, `ExperimentStore.ts`

### Architecture

```
ExperimentManager.startExperiment(targetId, scenarioId)
  └── TrafficController.start(targetId, scenario)
       ├── Load scenario (URL patterns, method, rate, duration)
       ├── Execute HTTP requests at configured rate
       └── onStatsCallback(targetId, { requestCount, errorCount, latency })
            └── ExperimentManager.updateExperimentStats(targetId, stats)
                └── ExperimentStore.save(experiment)
```

`ExperimentStore` persists to `data/experiments.json`.

### Live Stats Wiring

In `server/index.ts`:
```typescript
trafficController.onStatsCallback = (targetId, stats) =>
  experimentManager.updateExperimentStats(targetId, stats);
```

This callback wiring is done explicitly at startup — not inside the constructors — to avoid circular dependencies.

---

## 24. API Routes — Full Reference

**File:** `server/api/routes.ts`

All routes under `/api`. Router created by `createRouter(graphStore, wsManager, incidentManager, trafficController, experimentManager)`.

### Core Graph

| Method | Route | Handler |
|---|---|---|
| `GET` | `/api/graph` | `graphStore.getGraph()` |
| `GET` | `/api/nodes/:id` | `graphStore.getNode(id)` |
| `GET` | `/api/nodes/:id/metrics?range=5m` | `metricStore.getHistory(id, range)` |
| `GET` | `/api/nodes/:id/logs?tail=200` | SSH: `docker logs` via `discoveryEngine.getServiceLogs()` |
| `GET` | `/api/traffic?limit=100` | `metricStore.getEvents(limit)` |
| `GET` | `/api/analytics` | `GraphAnalytics.getAnalytics()` |
| `GET` | `/api/status` | Computed global health status |
| `GET` | `/api/diagnostics` | All targets + node/edge counts |

### Targets

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/targets` | All targets |
| `POST` | `/api/targets/register` | Register new target → `graphStore.registerNewProject()` |
| `PUT` | `/api/targets/:targetId` | Update target config |
| `DELETE` | `/api/targets/:targetId` | Remove target + all nodes/edges |
| `GET` | `/api/targets/:targetId/diagnostics` | Single target: node/edge count |
| `GET` | `/api/targets/:targetId/discovery` | `endpointRegistry.getSummary()` |
| `GET` | `/api/targets/:targetId/services` | `endpointRegistry.getServices()` |

### Telemetry Ingestion

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/ingest` | Remote collector → `graphStore.ingestRemote()` |
| `POST` | `/api/discovery/refresh` | Force re-discovery → `discoveryEngine.refreshTarget()` |

### Traces

Mounted via `createTraceRouter(graphStore, wsManager)`:

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/traces/:targetId/events?since=ISO` | TCP events from TraceStore |
| `GET` | `/api/traces/:targetId/graph?windowSec=300` | Aggregated call graph |
| `DELETE` | `/api/traces/:targetId` | Clear trace data for target |

### Traffic & Experiments

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/traffic/start` | Start scenario → `trafficController.start()` |
| `POST` | `/api/traffic/stop` | Stop → `trafficController.stop()` |
| `GET` | `/api/experiments` | All experiment history |
| `GET` | `/api/experiments/:id` | Single experiment |

### Incidents & RCA

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/incidents/:targetId` | Incident history |
| `POST` | `/api/incidents/:targetId/evaluate` | Manual RCA trigger |
| `GET` | `/api/incidents/:targetId/latest` | Latest incident for target |

---

## 25. WebSocket Protocol

All messages have the shape `{ type: string, data: any }`.

### Server → Client

| `type` | `data` | Trigger |
|---|---|---|
| `graph-update` | `{ nodes: ServiceNode[], edges: DependencyEdge[], targets: Target[] }` | Every 5s (polling) or immediately after ingest/discovery |
| `incident.updated` | `Incident` | RCA evaluation detects or updates an incident |
| `trace-events` | `{ targetId: string, events: ConnectionEvent[] }` | TCP events received in `ingestRemote()` |
| `TERMINAL_LOG` | `string` | Stdout/stderr line from bash/SSH child process |

### Client → Server

| `type` | `data` | Effect |
|---|---|---|
| `TERMINAL_EXEC` | `{ cmd: string, targetId?: string }` | Execute command in bash/SSH session |

---

## 26. Configuration Variables — All Sources

### `server/config.ts`

| Key | Env Var | Default | Description |
|---|---|---|---|
| `PORT` | `PORT` | `3001` | HTTP + WebSocket server port |
| `POLLING_INTERVAL_MS` | `POLLING_INTERVAL_MS` | `5000` | RCA eval + WS broadcast interval |
| `METRIC_HISTORY_SIZE` | `METRIC_HISTORY_SIZE` | `720` | Ring buffer size per node |
| `INGEST_TOKEN` | `INGEST_TOKEN` | `mapper-secret-token` | Bearer token for `/api/ingest` |
| `SOCK_SHOP_BASE_URL` | `SOCK_SHOP_BASE_URL` | `''` | Sock Shop HTTP base URL |
| `SOCK_SHOP_COMPOSE_PATH` | — | `./sock-shop-docker-compose.yml` | Compose file path |
| `VERTIKAL_BASE_URL` | `VERTIKAL_BASE_URL` | `''` | Vertikal HTTP base URL |
| `VERTIKAL_COMPOSE_PATH` | — | `../vertikal/docker-compose.yml` | Compose file path |

### Remote Collector (`remote-collector/index.ts`)

| Env Var | Default | Description |
|---|---|---|
| `MAPPER_URL` | `http://127.0.0.1:3001` | Backend ingest URL |
| `INGEST_TOKEN` | `mapper-secret-token` | Auth token |
| `TARGET_ID` | `sock-shop-aws` | Target ID in telemetry envelopes |
| `ENVIRONMENT` | `aws` | Deployment env label |
| `REGION` | `ap-south-1` | AWS region label |
| `POLLING_INTERVAL` | `5000` | Collection cycle (ms) |

### ML Pipeline (`ml/config.json`)

| Key | Default | Description |
|---|---|---|
| `collector_interval_s` | `10` | /api/graph poll interval |
| `api_base_url` | `http://localhost:3001` | Backend URL |
| `min_training_samples` | `30` | Min samples before model is created |
| `anomaly_threshold` | `0.7` | Score threshold for anomaly |
| `persistent_anomaly_windows` | `3` | Consecutive windows above threshold → persistent |

---

## 27. Data Files Reference

| File | Created By | Read By | Description |
|---|---|---|---|
| `data/graph_db.json` | `GraphStore.saveToDisk()` | `GraphStore.loadFromDisk()` | Full graph state snapshot |
| `data/remote_config.json` | `RemoteConfigPanel` (UI) | `GraphStore.loadTargetsFromConfig()`, `WebSocketManager` | SSH connection configs |
| `data/traces_<targetId>.json` | `TraceStore.saveEvents()` | `TraceStore.loadEvents()`, TraceRouter | TCP connection events (24h window) |
| `data/experiments.json` | `ExperimentStore.save()` | `ExperimentManager`, API | Experiment history |
| `ml/data/metrics_raw.csv` | `ml/collector.py` | `ml/preprocess.py` | Raw metric time series (grows indefinitely) |
| `ml/data/features.csv` | `ml/preprocess.py` | `ml/train.py` | Normalized feature matrix |
| `ml/data/normalization_stats.json` | `ml/preprocess.py` | `ml/score.py` | Per-service mean + std for normalization |
| `ml/data/latest_scores.json` | `ml/score.py` | `GraphStore.readAnomalyScores()` | Current anomaly scores (mtime-cached) |
| `ml/models/<id>.joblib` | `ml/train.py` | `ml/score.py` | Serialized IsolationForest per service |

---

## 28. Troubleshooting Runbook

### UI shows "NO DATA" for a target

1. Check if `data/remote_config.json` exists and has the correct IP + key path
2. Check server logs for SSH connection errors
3. Verify the EC2 instance is reachable: `ssh -i ~/.ssh/key.pem ubuntu@<ip> echo ok`
4. Check if `MAPPER_PUBLIC_URL` is set correctly (must be reachable from EC2)
5. Check the `endpointStatus` field in `/api/targets` — `UNCONFIGURED` means `baseUrl` is not set

### Nodes show 0% CPU / no metrics

**Most likely cause:** ID mismatch between discovery and collector.

1. Check `GET /api/diagnostics` — is `nodeCount > 0`?
2. Check server logs for `[TELEMETRY]` lines — is the `targetId` correct?
3. Check if node IDs in telemetry match the IDs in `nodesByTarget`
4. The `normalizeId()` function should handle this, but if a new separator format appears, it may not

### Edges disappear after a few minutes

1. Check if edge's `lastSeen` is being updated — it's only updated for observed edges
2. Declared-only edges are never pruned (no `lastSeen` requirement)
3. If a whole target's edges disappear, check `checkTargetStaleness()` — target may have gone `OFFLINE`

### Graphs show ghost nodes (old containers)

Ghost nodes are pruned after 15 minutes. If they persist beyond that:
1. Check if their `lastSeen` is being kept fresh by something (possibly a stale metric from a restart)
2. Manually trigger: `DELETE /api/targets/:targetId` and re-register to clear all state

### TracesView shows no events

1. Check if `events.connectionEvents` are being sent by the collector (look for `[TRACES]` in server logs)
2. `/proc/net/tcp` parsing may not be working on the EC2 instance — check OS (Linux only)
3. Check if `ipToNameMap` is populated — if containers don't have known IPs, no events are generated

### Terminal doesn't connect to remote

1. Check `data/remote_config.json` has `ec2PublicIp`, `sshUsername`, `sshKeyPath` for the target
2. Key path supports `~/` prefix — ensure it resolves correctly
3. SSH key must not have a passphrase (or use `ssh-agent`)
4. Check `StrictHostKeyChecking=no` in the SSH command — host key prompts block the session

### ML scores not showing on nodes

1. Check if `ml/data/latest_scores.json` exists: `ls -la ml/data/`
2. Score IDs must match node IDs exactly (`sock-shop:catalogue`, not `sock-shop-catalogue`)
3. Check mtime: `stat ml/data/latest_scores.json` — if unchanged in >10 minutes, `score.py` may have crashed

---

## 29. Adding a New Target — Step-by-Step

### Via UI

1. Open http://localhost:5173
2. Click **+ Add Project**
3. Fill: Target ID, Display Name, EC2 IP, SSH Username, SSH Key Path
4. Click **Connect**

The server:
- Saves to `data/remote_config.json`
- Calls `GraphStore.registerNewProject()`
- Immediately triggers `discoveryEngine.refreshTarget(targetId)`

### Via API

```bash
POST /api/targets/register
Content-Type: application/json

{
  "targetId": "my-app",
  "displayName": "My Application",
  "ec2PublicIp": "54.123.45.67",
  "sshUsername": "ubuntu",
  "sshKeyPath": "~/.ssh/myapp.pem"
}
```

### Adding a Custom Target Adapter

1. Create `server/collectors/MyAppAdapter.ts` extending `BaseCollector`
2. Implement:
   - `discover()` → returns `{ services, dependencies }`
   - `collectMetrics()` → returns `MetricSnapshot[]`
   - `getKnownDependencies()` → returns declared deps from config
3. Register in `EndpointDiscoveryEngine` alongside existing adapters

---

## 30. Known Bugs & Gotchas

### 1. `edgeActivity` Memory Leak (Fixed)

**Was:** When a node was pruned, its edges were deleted but their `edgeActivity` entries were never cleaned up. Over time, the map accumulated entries for long-dead edges.

**Fix:** `pruneStaleNodes()` now calls `this.edgeActivity.delete(edgeId)` for each pruned edge.

### 2. Positions Jump on Layout Change

When the 2D layout algorithm is switched (e.g., `clusters` → `dagre`), all node positions are recalculated. This is expected behavior. After the layout settles, dragging individual nodes works normally and survives metric updates (position preservation logic in `useGraphData`).

### 3. Short TCP Connections Missed

The `/proc/net/tcp` polling cycle is 5 seconds. Any connection that opens and closes within one polling interval is invisible to the Traces system. This is an inherent limitation of the polling approach.

**Not a bug — documented limitation.** Real distributed tracing would require OpenTelemetry instrumentation.

### 4. SSH Channel Exhaustion on Constrained EC2

On `t2.micro`/`t3.micro` instances with many containers, SSH channel creation may fail under load. Symptoms: discovery stops, telemetry gaps, target transitions to STALE. The system recovers automatically when SSH channels free up.

**Mitigation:** The separate `adHocConnManager` for log fetches reduces contention. The 15-minute node pruning threshold prevents data loss during temporary outages.

### 5. `clearRuntimeState()` Was Removed

Early versions cleared `graph_db.json`, `remote_config.json`, and `telemetry_db.json` on every server restart. This caused users to re-add their targets after every `npm run dev`.

**Fix:** The `clearRuntimeState()` call was commented out in `server/index.ts`. Target configs persist across restarts. State can be manually cleared by deleting the `data/` directory.

### 6. ML Scores Applied Every `getGraph()` Call

`readAnomalyScores()` is called on every `getGraph()` invocation (every 5 seconds). The mtime cache makes this O(1) when the file hasn't changed, but if `score.py` writes rapidly, the JSON parsing overhead adds up.

**Not critical** for current scale. For high-frequency scoring, consider a shared memory approach (Redis, or an HTTP endpoint on `score.py`).

---

*Last updated: September 2026 — Royson Salis*  
*This wiki reflects the actual codebase. If you find a discrepancy, file an issue.*

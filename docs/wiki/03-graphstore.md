# GraphStore — The Central Nervous System

**File:** `server/graph/GraphStore.ts`

GraphStore is the most important file in the project. Every node, edge, target, and metric flows through it. No other module keeps authoritative copies of graph state.

---

## Data Structures

```typescript
// Primary state — three parallel Maps, all keyed by targetId
public targets       = new Map<string, Target>();
public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();

// Supporting stores
public metricStore       = new MetricStore();        // time-series ring buffer
public endpointRegistry  = new EndpointRegistry();   // per-route HTTP stats
public discoveryEngine   : EndpointDiscoveryEngine;
private traceStores      = new Map<string, TraceStore>(); // lazy per-target

// Rolling TCP observation count per edge — powers the heat display
private edgeActivity = new Map<string, { count: number; windowStart: number }>();

// ML score mtime cache — avoids reparsing unchanged file
private anomalyScoresCache: { mtimeMs: number; data: Record<string, any> } | null = null;

// Debounce timer for disk writes
private saveTimeout: NodeJS.Timeout | null = null;
```

### Why Three Parallel Maps?

Each `nodesByTarget` entry is itself a `Map<nodeId, ServiceNode>`. This two-level structure lets you:
- Get all nodes for a target in O(1): `nodesByTarget.get(targetId)`
- Get a specific node in O(1): `nodesByTarget.get(targetId)?.get(nodeId)`
- Delete all nodes for a target without scanning the entire graph

Plain objects would work, but Maps don't have prototype chain issues and have guaranteed insertion-order iteration.

---

## Constructor & Startup Sequence

```
new GraphStore(wsManager?)
  1. Store wsManager reference
  2. Set storagePath = "data/graph_db.json"
  3. new EndpointDiscoveryEngine(this, wsManager)  ← callbacks wired in
  4. loadFromDisk()                                 ← restore previous state
  5. loadTargetsFromConfig()                        ← read remote_config.json
  6. discoveryEngine.discoverAll()                  ← initial SSH pass
  7. setInterval(10_000):
       ├── checkTargetStaleness()
       ├── pruneStaleNodes()
       ├── pingTargetEndpoints()
       ├── updateTargetDiscoverySummaries()
       └── broadcast('graph-update', getGraph())
```

Note: `clearRuntimeState()` was called here in early versions and removed. Calling it wiped targets every restart, forcing users to re-add them each time. The 10-second interval on the same setInterval as staleness checks avoids two separate timers for related tasks.

---

## Helper Accessors — Lazy Map Creation

```typescript
private getTargetNodes(targetId: string): Map<string, ServiceNode> {
  let m = this.nodesByTarget.get(targetId);
  if (!m) { m = new Map(); this.nodesByTarget.set(targetId, m); }
  return m;
}
```

Same pattern for `getTargetEdges`. This eliminates `if (!map) create; map.set(...)` boilerplate throughout every method that touches nodes or edges.

---

## `getGraph()` — The Read Path

Called on every WebSocket broadcast and every `GET /api/graph` request.

```typescript
getGraph(): { nodes: ServiceNode[], edges: DependencyEdge[], targets: Target[] } {
  // Flatten nodesByTarget into a single array
  const allNodes = [...this.nodesByTarget.values()].flatMap(m => [...m.values()]);
  const allEdges = [...this.edgesByTarget.values()].flatMap(m => [...m.values()]);

  // Attach ML scores (mtime-cached file read)
  const scores = this.readAnomalyScores();
  for (const node of allNodes) {
    const s = scores[node.id];
    if (s) node.analytics = {
      ...node.analytics,
      anomalyScore: s.anomaly_score,
      anomalyPersistent: s.persistent
    };
  }

  // Convert raw event counts → rates
  this.applyEdgeActivity(allEdges);

  return {
    nodes: allNodes,
    edges: allEdges,
    targets: [...this.targets.values()]
  };
}
```

### Design decision: ML scores applied at read time

The ML pipeline writes `ml/data/latest_scores.json` every 10 seconds. The server could watch this file with `fs.watch()` and push updates, but that adds complexity. Instead, scores are applied fresh on every `getGraph()` call using a mtime cache — if the file hasn't changed, the cached parse result is returned in microseconds.

---

## `ingestRemote()` — The Write Path

See [05-telemetry-ingestion.md](./05-telemetry-ingestion.md) for the full breakdown.

---

## `handleTopologyDiscovered()` — From SSH Discovery

Called by `EndpointDiscoveryEngine` when a discovery cycle completes.

```typescript
handleTopologyDiscovered(targetId: string, services: any[], dependencies: any[]) {
  const nodesMap = this.getTargetNodes(targetId);
  const edgesMap = this.getTargetEdges(targetId);

  // Upsert nodes — never overwrite a node that has richer runtime data
  for (const svc of services) {
    const id = `${targetId}:${svc.name}`;
    const existing = nodesMap.get(id);
    if (existing) {
      // Only update: status (from container state), lastSeen, metadata (merge)
      existing.status = svc.status;
      existing.lastSeen = new Date().toISOString();
      existing.metadata = { ...existing.metadata, ...svc.metadata };
    } else {
      nodesMap.set(id, { id, project: targetId, lastSeen: new Date().toISOString(), ...svc });
    }
  }

  // Upsert declared edges (never overwrite observed ones)
  for (const dep of dependencies) {
    const edgeId = `${targetId}:${dep.source}->${targetId}:${dep.target}`;
    if (!edgesMap.has(edgeId)) {
      edgesMap.set(edgeId, {
        id: edgeId,
        source: `${targetId}:${dep.source}`,
        target: `${targetId}:${dep.target}`,
        declared: true,
        observed: false,
        evidenceSources: ['compose-config'],
        status: 'unknown',
        metrics: null,
        ...
      });
    }
  }

  this.upsertTarget({ targetId, status: 'LIVE', lastSeen: new Date().toISOString() });
  this.scheduleSave();
  this.wsManager?.broadcast('graph-update', this.getGraph());
}
```

---

## `readAnomalyScores()` — mtime Cache

```typescript
private readAnomalyScores(): Record<string, any> {
  const scoresPath = path.join('..', 'ml', 'data', 'latest_scores.json');
  try {
    const stat = fs.statSync(scoresPath);
    if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
      return this.anomalyScoresCache.data;   // ← file unchanged, return cached
    }
    const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
    this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return {};  // File missing = no scores = graceful degradation
  }
}
```

Checking `statSync().mtimeMs` before `readFileSync` costs ~0.1ms and saves the JSON parse (~1-10ms) on every `getGraph()` call when the score file hasn't changed. The file is written every 10 seconds by `ml/score.py`, so caching is appropriate.

---

## `scheduleSave()` — Debounced Disk Write

```typescript
private scheduleSave(): void {
  if (this.saveTimeout) return;  // Already pending — don't stack up
  this.saveTimeout = setTimeout(() => {
    this.saveTimeout = null;
    this.saveToDisk();
  }, 2000);
}
```

Any number of calls within a 2-second window = exactly one disk write. During active telemetry ingestion, `ingestRemote()` is called ~12 times/minute (one per service per collection cycle). Without debouncing: 12 writes/minute per target. With debouncing: ~2 writes/minute total.

The 2-second window is a balance: short enough that state isn't lost if the process crashes, long enough to collapse bursts.

---

## `applyEdgeActivity()` — Heat Map Calculation

```typescript
private applyEdgeActivity(edges: DependencyEdge[]) {
  const now = Date.now();
  for (const edge of edges) {
    const bucket = this.edgeActivity.get(edge.id);
    if (!bucket) continue;  // No observations = no activity field

    const elapsedMs = Math.max(1000, now - bucket.windowStart);
    const perMin = (bucket.count / elapsedMs) * 60_000;

    edge.activity = {
      samplesPerMin: Math.round(perMin * 10) / 10,
      windowSec: Math.round(elapsedMs / 1000),
      lastSeen: new Date().toISOString(),
    };

    // Window reset every ~2 minutes — carry half to avoid snap-to-zero
    if (elapsedMs > 120_000) {
      this.edgeActivity.set(edge.id, {
        count: Math.floor(bucket.count / 2),
        windowStart: now - 60_000,
      });
    }
  }
}
```

### Why half-count carry-forward?

If we reset the counter to zero on window reset, the computed rate would briefly show zero (or spike depending on timing) every 2 minutes for each active edge. This creates a flickering effect in the heat visualization.

Carrying half the count forward means the rate smoothly decays rather than resetting. The window start is set to `now - 60_000` (midpoint of the old window) to give the new window a correct elapsed time for rate computation.

### Why no activity field for unobserved edges?

`"never seen" ≠ "measured as idle"`. An edge that has never had a TCP observation could be:
- A very-low-traffic dependency that sampling has missed
- A declared-but-not-observed dependency
- A recently-added edge with no history yet

Showing `samplesPerMin: 0` would imply we measured it and confirmed it's quiet. We didn't. Omitting the field is more honest.

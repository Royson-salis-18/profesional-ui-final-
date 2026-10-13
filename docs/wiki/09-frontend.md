# Frontend — Architecture, Hooks & Design Decisions

**Directory:** `client/src/`

---

## Entry Points

```
client/src/main.tsx   → renders <App /> into #root
client/src/App.tsx    → root orchestrator (465 lines)
```

`App.tsx` owns all UI state and consumes the `useGraphData` hook. It does not fetch data directly — all data flows through the hook.

---

## `useGraphData` Hook — The Data Layer

**File:** `client/src/hooks/useGraphData.ts`

This hook is the **single data source** for the entire frontend. It manages:
- Initial HTTP fetch (`GET /api/graph` + `GET /api/status`)
- WebSocket connection + auto-reconnect
- All graph state (`nodes`, `edges`, `targets`, `isConnected`, `status`)
- Terminal state (`terminalLogs`, `sendTerminalCommand`)
- `reloadGraph(targetId)` — triggers server-side discovery refresh

### Position Preservation Logic

When a `graph-update` WebSocket message arrives, the hook must decide whether to:
1. **Keep existing positions** (if topology is the same — just metrics changed)
2. **Recalculate layout** (if nodes were added or removed)

Without position preservation: nodes jump to recalculated positions every 5 seconds, making the graph unusable.

```typescript
setNodes(prevNodes => {
  const prevIds = new Set(prevNodes.map(n => n.id));
  const newIds  = new Set(newNodes.map(n => n.id));
  const sameSet = prevIds.size === newIds.size &&
                  [...newIds].every(id => prevIds.has(id));

  if (sameSet && prevNodes.length > 0) {
    // Same topology — preserve positions, update data only
    return prevNodes.map(prev => {
      const updated = newNodes.find(n => n.id === prev.id);
      return updated ? { ...prev, data: updated } : prev;
    });
  } else {
    // Topology changed — new nodes need layout positions
    // But keep positions for nodes that already existed
    return newNodes.map(newNode => {
      const existing = prevNodes.find(p => p.id === newNode.id);
      return existing ? { ...existing, data: newNode } : newNode;
    });
  }
});
```

### WebSocket Reconnect

```typescript
ws.onclose = () => {
  setIsConnected(false);
  setTimeout(connectWs, 3000);  // Fixed 3-second delay
};
ws.onerror = () => ws.close();  // onclose → reconnect
```

**Fixed delay, not exponential backoff:** The backend is on the same host or VPN and should restart within seconds. Exponential backoff would cause an unnecessarily long gap before reconnecting.

### Terminal Multiplexing

```typescript
const sendTerminalCommand = (cmd: string, targetId?: string) => {
  if (ws.current?.readyState === WebSocket.OPEN) {
    ws.current.send(JSON.stringify({
      type: 'TERMINAL_EXEC',
      data: { cmd, targetId }
    }));
  }
};
```

Reuses the same WebSocket connection that receives graph updates. The server routes `TERMINAL_EXEC` messages to a dedicated bash/SSH child process per connection. See [10-websocket.md](./10-websocket.md).

---

## Layout System

**Files:** `App.tsx` (signature computation), `client/src/components/layouts2d.ts` (algorithm implementations)

### The Problem: Expensive Layout on Every Poll

`filteredNodes` and `filteredEdges` get new array references on every WebSocket poll (every 5 seconds). If the layout computation was keyed on these arrays directly, Dagre/force calculations would re-run multiple times per second even when only `node.metrics.cpu` changed.

### The Solution: Layout Signature

```typescript
// Stable string that only changes when topology changes (not metrics)
const layoutSignature2d = useMemo(() => {
  const nodePart = filteredNodes
    .map(n => {
      const d = n.data as any;
      return `${n.id}:${d?.type ?? ''}:${d?.project ?? ''}`;
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
  [layout2d, layoutSignature2d]  // ← NOT filteredNodes/filteredEdges directly
);
```

When `node.metrics.cpu` changes from `23.1` to `24.7`, the signature stays the same → layout doesn't recompute → no position change → no jump.

### Layout Algorithms

| ID | Algorithm | Best for |
|---|---|---|
| `clusters` | Group by project + node type | Multi-target views, default |
| `dagre` | Hierarchical directed graph | Understanding service hierarchies |
| `force` | Physics simulation | Discovering natural clustering |
| `radial` | Circular arrangement | Single-target overview |

### Layout Persistence

```typescript
// Load on mount
const [layout2d, setLayout2d] = useState<Layout2DId>(() =>
  (localStorage.getItem('mm.graph.layout2d') as Layout2DId) || 'clusters'
);

// Save on change
useEffect(() => {
  try { localStorage.setItem('mm.graph.layout2d', layout2d); } catch { /* private mode */ }
}, [layout2d]);
```

`try/catch` around `localStorage.setItem` handles Safari private mode where storage is unavailable. Layout preference persists across browser refreshes.

---

## App State — What Lives Where

```typescript
// Project filter
const [selectedProjectId, setSelectedProjectId] = useState<string>('ALL');

// Active tab
const [activeTab, setActiveTab] = useState<string>('3D Vision');

// View mode (which edges to show)
const [viewMode, setViewMode] = useState<'combined' | 'architecture' | 'runtime'>('combined');

// Selected node/edge (for inspection panels)
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

// Node highlight (node + its direct neighbors)
const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());

// Terminal
const [terminalVisible, setTerminalVisible] = useState(false);
const [terminalPosition, setTerminalPosition] = useState({ x: 20, y: 80 });

// 2D layout
const [layout2d, setLayout2d] = useState<Layout2DId>('clusters');
```

### Filtered Nodes & Edges

```typescript
// Filter by selected project
const filteredNodes = useMemo(() => {
  if (selectedProjectId === 'ALL') return nodes;
  return nodes.filter(n => (n.data as any)?.project === selectedProjectId);
}, [nodes, selectedProjectId]);

// Filter by view mode
const filteredEdges = useMemo(() => {
  return edges.filter(e => {
    if (viewMode === 'architecture') return (e.data as any)?.declared;
    if (viewMode === 'runtime')      return (e.data as any)?.observed;
    return true;  // 'combined' = all edges
  }).filter(e =>
    filteredNodes.some(n => n.id === e.source) &&
    filteredNodes.some(n => n.id === e.target)
  );
}, [edges, filteredNodes, viewMode]);
```

### Highlight Propagation

When a node is selected, all its direct neighbors are highlighted:

```typescript
const handleNodeSelect = (nodeId: string) => {
  setSelectedNodeId(nodeId);
  const neighborIds = new Set([nodeId]);
  for (const edge of filteredEdges) {
    if (edge.source === nodeId) neighborIds.add(edge.target);
    if (edge.target === nodeId) neighborIds.add(edge.source);
  }
  setHighlightedNodeIds(neighborIds);
};
```

Unhighlighted nodes render at `opacity: 0.2`. This focuses attention on the selected service and its immediate dependencies without hiding the rest of the graph.

---

## Component Reference

| Component | File | Key Props / Role |
|---|---|---|
| `Sidebar` | `Sidebar.tsx` | Tab navigation, global status LED |
| `TopBar` | `TopBar.tsx` | Project selector, search, WS badge, Traffic button |
| `GraphCanvas` | `GraphCanvas.tsx` | ReactFlow wrapper — registers `customServiceNode` + `customDependencyEdge` types |
| `ServiceNode` | `ServiceNode.tsx` | Custom ReactFlow node: health LED, CPU/mem gauges, type icon |
| `DependencyEdge` | `DependencyEdge.tsx` | Custom ReactFlow edge: animated/solid, color by status |
| `Scene3D` | `3d/Scene3D.tsx` | Three.js canvas with orbit controls, lighting, 3D layout |
| `Node3D` | `3d/Node3D.tsx` | Sphere per service — glow/pulse based on health status |
| `Edge3D` | `3d/Edge3D.tsx` | Tube/cylinder between spheres |
| `InspectionPanel` | `InspectionPanel.tsx` | Slide-in panel: node details, metric charts, log viewer |
| `EdgeInspectionPanel` | `EdgeInspectionPanel.tsx` | Slide-in panel: edge metrics, evidence sources |
| `TelemetryView` | `TelemetryView.tsx` | Sortable metrics table (all nodes) |
| `TracesView` | `TracesView.tsx` | TCP event live stream + aggregated graph |
| `RCAView` | `RCAView.tsx` | Incident timeline, candidate ranking, evidence |
| `MLPipelineView` | `MLPipelineView.tsx` | Model status, anomaly scores, training controls |
| `TrafficControlPanel` | `TrafficControlPanel.tsx` | Start/stop traffic scenarios |
| `RemoteConfigPanel` | `RemoteConfigPanel.tsx` | Add/edit remote targets |
| `TerminalPanel` | `TerminalPanel.tsx` | Floating draggable SSH terminal |
| `WelcomeScreen` | `WelcomeScreen.tsx` | Shown when no targets configured |
| `GraphControls` | `GraphControls.tsx` | View mode toggle, layout picker, type filters |

---

## Edge Visualization Semantics

**File:** `client/src/components/DependencyEdge.tsx`

| `declared` | `observed` | `status` | Visual |
|---|---|---|---|
| `true` | `false` | any | Solid grey — declared but no confirmed runtime traffic |
| `false` | `true` | `active` | Animated cyan "marching ants" |
| `true` | `true` | `active` | Animated cyan "marching ants" |
| any | any | `degraded` | Animated yellow |
| any | any | `failed` | Animated red |

The animation is pure CSS — `stroke-dasharray` + `stroke-dashoffset` with a CSS keyframe animation. Speed and color update reactively based on `edge.status`.

Edge **thickness/opacity** is driven by `edge.activity?.samplesPerMin`. Higher observation rate → thicker/brighter edge. This is the "heat map" effect.

---

## `TracesView` — What It Actually Is

`client/src/components/TracesView.tsx` has a prominent comment at the top:

```typescript
/**
 * Connection Traces View — SSH-sampled TCP connection events.
 *
 * This is NOT distributed tracing (no OpenTelemetry/Zipkin spans).
 * It shows raw TCP connections between containers, captured by reading
 * /proc/net/tcp on the remote host at collection-cycle granularity.
 *
 * Limitations:
 * - Samples at ~5s intervals; short-lived connections may be missed
 * - No per-request latency information
 * - Shows connections, not individual HTTP requests
 */
```

The view has two modes:
1. **Live feed** — real-time `ConnectionEvent` objects arriving via WebSocket `trace-events`
2. **Historical graph** — aggregated call graph from `GET /api/traces/:targetId/graph?windowSec=300`

The `shortName(serviceId)` helper strips the `targetId:` prefix for display: `"sock-shop:catalogue"` → `"catalogue"`.

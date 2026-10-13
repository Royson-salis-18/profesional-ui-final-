# Architecture — System Layers & Data Flow

## Component Map

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         MICROSERVICE MAPPER                               │
│                                                                           │
│  ┌─────────────────────┐         ┌───────────────────────────────────┐   │
│  │  React 19 Client    │◄──WS────│  Node.js/Express Server :3001     │   │
│  │  Vite :5173         │──REST──►│                                   │   │
│  │                     │         │  ┌─────────────────────────────┐  │   │
│  │  2D Graph (XYFlow)  │         │  │         GraphStore           │  │   │
│  │  3D View (Three.js) │         │  │  nodesByTarget Map<id,Node>  │  │   │
│  │  Telemetry Table    │         │  │  edgesByTarget Map<id,Edge>  │  │   │
│  │  Traces View        │         │  │  targets Map<id,Target>      │  │   │
│  │  RCA Dashboard      │         │  └──────────┬────────────────── ┘  │   │
│  │  ML Pipeline View   │         │             │                       │   │
│  │  Terminal           │         │  MetricStore (ring buffer)          │   │
│  └─────────────────────┘         │  TraceStore (per-target JSON)       │   │
│                                  │  EndpointRegistry (routes)          │   │
│                                  │  RCAEngine + IncidentManager        │   │
│                                  │  TrafficController + Experiments    │   │
│                                  │  WebSocketManager (broadcast+term)  │   │
│                                  └───────────────┬───────────────────  │   │
│                                                  │ SSH tcp/22          │   │
│                                  ┌───────────────▼───────────────────  │   │
│                                  │   Remote EC2 Instance               │   │
│                                  │                                     │   │
│                                  │  remote-collector (Node.js)         │   │
│                                  │  ├ /var/run/docker.sock             │   │
│                                  │  │  └ container stats               │   │
│                                  │  │  └ container log streams         │   │
│                                  │  │  └ container events              │   │
│                                  │  └ /proc/net/tcp polling            │   │
│                                  │                                     │   │
│                                  │  Target App (Docker Compose)        │   │
│                                  │  ├ Sock Shop (Traefik gateway)      │   │
│                                  │  └ Vertikal (NGINX gateway)         │   │
│                                  └─────────────────────────────────── ─│   │
│                                                                         │   │
│  ┌──────────────────┐  reads ml/data/latest_scores.json                │   │
│  │  ML Pipeline     │──────────────────────────────────────────────►   │   │
│  │  Python sidecar  │                                                   │   │
│  └──────────────────┘                                                   │   │
└───────────────────────────────────────────────────────────────────────────┘
```

## Five Layers

### Layer 1 — Frontend Client (`/client`)

**Tech:** React 19, Vite 8, TypeScript 6, `@xyflow/react` v12, Three.js v0.186, Recharts v3, Framer Motion v13, Lucide React

**Entry point:** `client/src/main.tsx` → `App.tsx`

The client renders graph state it receives over WebSocket. It does no polling — all data arrives pushed from the server. The main views are:

- **Default / 2D Graph** — ReactFlow canvas with custom node + edge components
- **3D Vision** — Three.js scene with orbit controls, one sphere per service
- **Telemetry** — Sortable metrics table
- **TRACES** — Live TCP connection stream + aggregated call graph
- **RCA / INCIDENTS** — Root cause analysis results and incident timeline
- **ML PIPELINE** — Anomaly detection status, model info
- **EXPERIMENTS** — Traffic experiment history
- **Analytics** — Graph-level stats (centrality, health scores)

### Layer 2 — Backend Server (`/server`)

**Tech:** Node.js 18+, Express 5, TypeScript 5.7, `ws` v8, `ssh2` v1, `dockerode` v4

**Entry point:** `server/index.ts`

The server is the brain. It owns all state and is the only component that writes to disk. Key subsystems:
- `GraphStore` — central state (nodes, edges, targets, metrics)
- `EndpointDiscoveryEngine` — SSH connection management + topology discovery
- `RCAEngine` / `IncidentManager` — failure analysis
- `WebSocketManager` — broadcast hub + embedded terminal
- `TrafficController` / `ExperimentManager` — load test execution

### Layer 3 — Remote Collector (`/remote-collector`)

**Tech:** Node.js, `dockerode`, `axios`

A standalone process deployed on each EC2 instance. Reads the Docker socket and `/proc/net/tcp`, packages the data into `TelemetryEnvelope` payloads, and POSTs them to the backend. No persistent state. Stateless and restartable at any time.

### Layer 4 — ML Pipeline (`/ml`)

**Tech:** Python 3, scikit-learn (IsolationForest), pandas

A completely separate process. Reads from `/api/graph`, writes `ml/data/latest_scores.json`. The server reads this file; it never calls Python. Optional — the system works without it.

### Layer 5 — Target Workloads

Unmodified Docker Compose applications. No agents, no sidecars, no config changes required. The system works by observing from the outside.

---

## Data Flow — Step by Step

### 1. Initial Discovery (SSH)

```
server/index.ts startup
  └── new GraphStore(wsManager)
       └── discoveryEngine.discoverAll()
            └── for each target in remote_config.json:
                 └── TargetAgent.start()
                      ├── SSH connect (ssh2 via ConnectionManager)
                      ├── "docker ps --format json" → container list
                      ├── "cat docker-compose.yml" → declared deps
                      └── GraphStore.handleTopologyDiscovered(targetId, services, deps)
                           ├── upsert nodes (status from container state)
                           ├── upsert edges (declared:true, observed:false)
                           └── scheduleSave() + broadcast('graph-update')
```

### 2. Telemetry Collection (5-second cycle)

```
remote-collector (on EC2)
  ├── docker stats → CPU/memory/network per container
  ├── docker logs (since last cycle) → HTTP log parsing
  └── /proc/net/tcp → established TCP connections

  POST /api/ingest  { targetId, events: { nodes, edges, metrics, interactions, connectionEvents } }
    └── GraphStore.ingestRemote(payload)
         ├── events.nodes         → upsert nodes
         ├── events.edges         → merge (never overwrite observed with declared)
         ├── events.metrics       → MetricStore.push() + node.metrics inline
         ├── events.interactions  → MetricStore.pushEvent() + edge upsert/upgrade
         └── events.connectionEvents
              ├── TraceStore.saveEvents() → disk + ring buffer
              ├── broadcast('trace-events') → TracesView live feed
              └── edgeActivity[id].count++
```

### 3. Read Path — Every 5 seconds (server-side interval)

```
setInterval(5000):
  ├── broadcast('graph-update', graphStore.getGraph())
  │    └── getGraph()
  │         ├── applyEdgeActivity() → edge.activity.samplesPerMin
  │         ├── readAnomalyScores() → node.analytics.anomalyScore (mtime-cached)
  │         └── return { nodes, edges, targets }
  └── for each target:
       └── incidentManager.evaluateTarget(targetId)
            └── RCAEngine.analyzeIncident(...)
                 └── broadcast('incident.updated', incident)
```

### 4. Client Side — Position Preservation

```
WebSocket onmessage('graph-update', { nodes, edges, targets })
  └── useGraphData hook
       ├── If topology unchanged (same node IDs):
       │    → preserve x,y positions, update node.data only
       │    → nodes don't jump during metric updates
       └── If topology changed (node added/removed):
            → recalculate layout, keep positions for existing nodes
```

---

## Ports & Network

| Port | Service | Protocol |
|---|---|---|
| 3001 | Backend server | HTTP + WebSocket (same port) |
| 5173 | Frontend (dev) | HTTP (Vite dev server) |
| 22 | EC2 SSH | SSH (outbound from server to EC2) |

The remote collector on EC2 talks to `http://127.0.0.1:3001` — this works because the backend opens a **reverse SSH tunnel** (`-R 3001:localhost:3001`) when connecting to EC2. So the collector reaches the backend through the tunnel without any inbound firewall rules.

---

## What Persists Across Restarts

| Data | File | Notes |
|---|---|---|
| Graph state (nodes, edges, targets) | `data/graph_db.json` | Full state, loaded on startup |
| Target SSH configs | `data/remote_config.json` | Required to reconnect on restart |
| TCP connection events | `data/traces_<targetId>.json` | 24-hour window per target |
| Experiment history | `data/experiments.json` | All past experiment runs |
| ML training data | `ml/data/metrics_raw.csv` | Grows indefinitely (append-only) |

**NOT persisted:** MetricStore ring buffers (history resets on restart, current values re-populated in first telemetry cycle), edgeActivity counters (heat display starts cold).

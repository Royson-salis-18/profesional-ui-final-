<div align="left">
  <a href="https://github.com/Royson-salis-18"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" /></a>
  <a href="https://www.linkedin.com/in/royson-salis-3ab32628a/"><img src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" /></a>
  <a href="https://www.instagram.com/royson._/"><img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" /></a>
  <a href="mailto:roysonsalis2005@gmail.com"><img src="https://img.shields.io/badge/Gmail-D14836?style=for-the-badge&logo=gmail&logoColor=white" /></a>
</div>

---

# Graph service (formerly "Microservice Mapper")

> **Scope note.** This document describes the graph service in `server/` (SSH collection, topology discovery, the dependency graph, traffic
> generation) and the UI in `client/`. Root-cause analysis and cascade prediction are now done by the Python core in `core/`; the rule-based
> engine described below is only the fallback used while the core is offline or still collecting history. See the repository README.

**Real-time observability for Docker-based microservices — zero code changes required.**

Microservice Mapper connects to your EC2 instances over SSH, discovers your service topology from Docker Compose files and running containers, collects live telemetry, and renders an interactive 2D/3D dependency graph. Point it at a running stack and see your architecture come alive within seconds.

```
SSH into EC2 → Read Docker socket + /proc/net/tcp → Build live dependency graph → Visualize
```

---

## What It Does

- **Topology discovery** — reads your Compose file over SSH; discovers declared `depends_on` relationships
- **Runtime observation** — watches active TCP connections and parses container logs to confirm which services actually talk to each other
- **Live metrics** — CPU, memory, network I/O from Docker stats API, refreshed every 5 seconds
- **Root cause analysis** — when services degrade, an evidence-based scoring algorithm identifies the most likely root cause and traces the propagation path
- **Anomaly detection** — optional Python ML sidecar runs per-service IsolationForest models and feeds scores back into the graph
- **Traffic experiments** — built-in load test runner with experiment tracking
- **Embedded terminal** — SSH terminal into any target directly from the UI

## What It Is NOT

This is not a distributed tracing tool. There are no OpenTelemetry spans or request IDs. The "Traces" view shows SSH-sampled TCP connection snapshots from `/proc/net/tcp` — sampled at 5-second intervals, not per-request. No code changes are required in your applications.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, TypeScript |
| 2D Graph | `@xyflow/react` v12 (ReactFlow) |
| 3D View | Three.js + `@react-three/fiber` |
| Charts | Recharts |
| Animations | Framer Motion |
| Backend | Node.js 18+, Express 5, TypeScript |
| WebSocket | `ws` v8 (raw — no Socket.io) |
| SSH | `ssh2` v1 |
| Docker API | `dockerode` v4 |
| ML Pipeline | Python 3, scikit-learn (IsolationForest) |

---

## Quick Start

### Prerequisites

- Node.js 20+ (22 recommended), npm 9+
- An SSH key (`.pem`) for your EC2 instances (Docker runs on the instances, not on your machine)
- Optional: Python 3.10+ for the ML panel, an `ssh` client for the in-app terminal, Docker only to map containers on this machine

The mapper runs the same on **macOS, Linux and Windows**: the targets are always reached over SSH, and everything that
differs by OS (Python binary name, Docker socket, local shell, SSH key paths and permissions) is handled in
`server/util/platform.ts`.

### Install & Run

macOS (Terminal):
```bash
# once: brew install node@22   (Homebrew from https://brew.sh)
git clone https://github.com/Royson-salis-18/microservice-mapper.git
cd microservice-mapper
npm run setup        # installs every sub-project, then runs the doctor
npm run dev
```
Windows (PowerShell): the same commands. Install Node with `winget install OpenJS.NodeJS.LTS` (or nodejs.org).
Linux: the same commands, with Node 22 from your package manager or nodejs.org.

Open **http://localhost:5173**. The server runs on **:3001**; the Vite client on **:5173** proxies `/api` + `/ws` to it.

`npm run doctor` checks this machine and says how to fix anything missing (Node, dependencies, Python, ssh, Docker, and
whether each target's SSH key file exists here).

**SSH keys across machines.** Key paths may be written as `~/Downloads/key.pem`, `~\Downloads\key.pem`, a quoted path or
an absolute path from another computer. If the exact path is not found, the mapper looks for a file with the same name in
`~/.ssh`, `~/Downloads`, `~/Desktop` and `~/Documents`, so a config made on Windows works on a Mac. A freshly downloaded
key that is readable by others is fine for discovery; for the in-app terminal the mapper hands `ssh` a private copy
instead of changing your file.

**Overrides:** `MAPPER_PYTHON=/path/to/python` (for example a virtualenv), `DOCKER_HOST=...` (a non-default Docker), `MAPPER_AUTO_RESTART=on` (restart crashed containers on reconnect; off by default so injected faults are not silently repaired).

### npm Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start server + client concurrently |
| `npm run server` | Start backend only |
| `npm run client` | Start Vite dev server only |
| `npm run build` | Production client build |
| `npm run install:all` | Install the root tools and server, client, remote-collector, traffic-gen |
| `npm run setup` | `install:all` + `doctor` |
| `npm run doctor` | Check this machine (any OS) and print fixes |
| `npm run traffic-gen` | Run traffic generator |
| `npm test` | Run the test suite (logic, RCA, security, cross-platform) |

---

## Adding a Target

1. Open http://localhost:5173
2. Click **+ Add Project**
3. Fill in: Target ID, Display Name, EC2 Public IP, SSH Username, SSH Key Path
4. Click **Connect**

The server SSH connects immediately, reads the Compose file, discovers containers, and starts telemetry collection. Target configuration is saved to `data/remote_config.json` and persists across restarts.

### Supported Target Systems

| System | Type | Notes |
|---|---|---|
| **Sock Shop** (Weave Works) | E-commerce demo | Traefik gateway, RabbitMQ queue |
| **Vertikal** | Financial trading sim | NGINX gateway, TimescaleDB |
| Any Docker Compose app | Custom | Works with any stack — type detection is heuristic-based |

---

## How It Works

### Hybrid Graph Model

The system combines two sources of truth:

| Source | How collected | Edge type |
|---|---|---|
| **Declared** | `depends_on` in `docker-compose.yml` read via SSH `cat` | Grey solid line — configured but not confirmed |
| **Observed (HTTP)** | Container log parsing — regex on access log lines | Cyan animated line — confirmed by actual HTTP traffic |
| **Observed (TCP)** | `/proc/net/tcp` polling | Drives edge "heat" (TCP observations/minute) |

An edge can be declared-only, observed-only, or both. This immediately surfaces:
- Declared deps with no runtime traffic (dead code / misconfiguration)
- Runtime traffic not in any Compose file (undocumented dependencies)

### Node ID Format

All nodes use a canonical format: `${targetId}:${serviceName}` — e.g., `sock-shop:catalogue`. This prevents ID mismatches between subsystems. See [wiki/04-id-system.md](./wiki/04-id-system.md).

### Persistence

State persists to `data/graph_db.json` (debounced 2-second write). Nodes not updated for 15+ minutes are automatically pruned (ghost prevention). Targets go `STALE` after 2 minutes and `OFFLINE` after 5 minutes without telemetry.

---

## Root Cause Analysis

The RCA is the rca-lab research method, ported and tested (details and measurements: [wiki/08-rca-engine.md](wiki/08-rca-engine.md)).

1. **Detect.** Every service's CPU, memory, network rates (and latency, error rate and traffic when a request-level
   source exists) are compared with that service's own last 15 minutes. The comparison uses a robust baseline that
   drops past incidents, counts only the bad direction, uses a log scale and normalises for noise. Two samples in a
   row must agree. A busy service that suddenly does **nothing** is flagged as **silent** (frozen). A paused, stopped,
   restarting or vanished container is **hard evidence**.
2. **Attribute.** `score = max(own evidence, symptoms not explained by a broken dependency) + hard evidence`. A broken
   service explains its callers' errors, so victims fall down the list. If most services go silent at once, a
   **monitoring outage** is reported instead of blaming anyone.
3. **Cascade.** Healthy services calling a broken one are listed as **at risk next** (noisy-OR).

Measured on the mapper's own stored history (323 series-hours from real targets): about **9× fewer alarms** than the
previous detector, while catching as many or more of the faults injected into the same data. Every rule and threshold
is visible and editable in the UI (Incident rules), and `data/incident_thresholds.json` overrides the defaults.

---

## ML Anomaly Detection (Optional)

A separate Python pipeline trains per-service IsolationForest models on historical metrics:

```bash
cd ml
pip install -r requirements.txt

# Collect baseline (run during normal operation)
python3 collector.py &

# Train models
python3 preprocess.py
python3 train.py

# Start live scoring
python3 score.py &
```

The server reads `ml/data/latest_scores.json` on each graph request using a mtime cache. No Python API calls at runtime — just a file read.

---

## Deployment

### Environment (server/.env)

```env
PORT=3001
INGEST_TOKEN=your-strong-secret-here
POLLING_INTERVAL_MS=5000
SOCK_SHOP_BASE_URL=http://<your-ec2-ip>:80
```

### systemd (production)

```ini
[Unit]
Description=Microservice Mapper Server
After=network-online.target

[Service]
WorkingDirectory=/home/ubuntu/microservice-mapper/server
ExecStart=/usr/bin/npm run start
Restart=always
Environment=PORT=3001
Environment=INGEST_TOKEN=your-secret

[Install]
WantedBy=multi-user.target
```

### NGINX (SSL + static files)

```nginx
server {
    listen 443 ssl;
    server_name mapper.yourdomain.com;

    location /api { proxy_pass http://localhost:3001; }
    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    location / {
        root /home/ubuntu/microservice-mapper/client/dist;
        try_files $uri /index.html;
    }
}
```

---

## Project Structure

```
microservice-mapper/
├── server/          # Node.js/Express backend (:3001)
│   ├── graph/       # GraphStore — central state (most important file)
│   ├── discovery/   # SSH-based topology discovery
│   ├── rca/         # Root cause analysis engine
│   ├── traces/      # TCP connection event storage
│   ├── telemetry/   # MetricStore ring buffer
│   ├── traffic/     # Load test execution + experiments
│   ├── api/         # REST routes + WebSocket manager
│   └── models/      # TypeScript interfaces
├── client/          # React 19 + Vite frontend (:5173)
│   └── src/
│       ├── components/  # UI components (2D graph, 3D scene, panels)
│       ├── hooks/       # useGraphData — WebSocket + HTTP data hook
│       └── types/       # Client-side TypeScript interfaces
├── remote-collector/ # Standalone Node.js collector (deploy to EC2)
├── ml/              # Python anomaly detection pipeline
├── traffic-gen/     # HTTP traffic scenario runner
├── data/            # Runtime state files (auto-created)
└── wiki/            # Complete technical documentation
```

---

## Documentation

Full technical documentation lives in the **[wiki/](./wiki/)** directory:

| Document | Topic |
|---|---|
| [01-overview.md](./wiki/01-overview.md) | What the system is and isn't |
| [02-architecture.md](./wiki/02-architecture.md) | Component map, full data flow |
| [03-graphstore.md](./wiki/03-graphstore.md) | Central state store internals |
| [04-id-system.md](./wiki/04-id-system.md) | Canonical IDs and normalization |
| [05-telemetry-ingestion.md](./wiki/05-telemetry-ingestion.md) | `ingestRemote()` stage by stage |
| [06-node-edge-lifecycle.md](./wiki/06-node-edge-lifecycle.md) | Pruning, staleness, ghost prevention |
| [07-remote-collector.md](./wiki/07-remote-collector.md) | Docker socket, log parsing, TCP polling |
| [08-rca-engine.md](./wiki/08-rca-engine.md) | Scoring algorithm and incident lifecycle |
| [09-frontend.md](./wiki/09-frontend.md) | React hooks, layouts, edge visuals |
| [10-websocket.md](./wiki/10-websocket.md) | Broadcast protocol, terminal multiplexer |
| [11-ml-pipeline.md](./wiki/11-ml-pipeline.md) | IsolationForest pipeline and integration |
| [12-data-models.md](./wiki/12-data-models.md) | All TypeScript interfaces |
| [13-api-reference.md](./wiki/13-api-reference.md) | Full REST + WebSocket API |
| [14-configuration.md](./wiki/14-configuration.md) | All env vars and config files |
| [15-troubleshooting.md](./wiki/15-troubleshooting.md) | Common issues and known bugs |

---

## Known Limitations

- **Connection sampling, not per-request tracing** — the sweep counts sockets in `ESTABLISHED` and `TIME_WAIT`. `TIME_WAIT` lingers ~60s, so short request/response cycles between two sweeps are usually still caught, but nothing here is a per-request record
- **No per-edge latency or error rate** — `edge.metrics` is `null` in a Docker/SSH deployment. Edge heat is graded on observed connection volume (`activity.samplesPerMin`), which is a concurrency proxy, not HTTP load
- **HTTP/1.1 log parsing only** — no HTTP/2 or gRPC log parsing
- **Linux targets only** — `/proc/net/tcp` is Linux-specific
- **No auto-retraining** — ML models must be manually retrained as data accumulates
- **Single backend instance** — no built-in clustering

---

## Contact

- **GitHub Issues**: https://github.com/Royson-salis-18/microservice-mapper/issues
- **Email**: roysonsalis2005@gmail.com

---

*Royson Salis — September 2026*

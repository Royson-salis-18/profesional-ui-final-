<div align="left">
  <a href="https://github.com/Royson-salis-18"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" /></a>
  <a href="https://www.linkedin.com/in/royson-salis-3ab32628a/"><img src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" /></a>
  <a href="mailto:roysonsalis2005@gmail.com"><img src="https://img.shields.io/badge/Gmail-D14836?style=for-the-badge&logo=gmail&logoColor=white" /></a>
</div>

---

# Root-cause analysis and cascade-failure prediction for microservices

Point it at a running Docker-based system. It **maps** who calls whom, **notices** when a service stops behaving like itself, **blames** the
service that broke first (not the loudest victim), and **predicts** which healthy services get dragged down next. No labels, no training,
no code changes in the target.

| step | question | where |
|---|---|---|
| 1 Map | who calls whom? | `server/` (SSH discovery, evidence-tagged dependency graph) and `core/algo.py` (graph helpers) |
| 2 Notice | is something wrong, with a known false-alarm rate? | `core/algo.py` (detection) |
| 3 Blame | which service broke first? | `core/algo.py` (attribution) |
| 4 Predict | who is dragged down next? | `core/algo.py` (cascade risk) |

## How good is it?

Measured on 751 labelled faults injected into real OpenTelemetry traffic (seeds never used for tuning), recomputed by `python -m core.evaluation`:

| | root first | top 3 | false alarms / h |
|---|---|---|---|
| **this method** | **69.5%** (66.2 to 72.5) | **76.8%** | 0.17 |
| previous lab method (`archive/lab-v1`) | 27 to 40% | 41% | 0.0 (detects only ~41% of faults) |
| original notebook method | 45.4% | 52.5% | 79.7 |

Crashes and freezes are found every time, error faults 61%, **slow faults only 16%** (the open problem). The one real fault (a stopped
container on AWS) is ranked #1 of 27. That is a demonstration, not a statistic. Cascade prediction cannot be validated on this bench.
Full tables, what each part is worth, and the limits: [docs/EVALUATION.md](docs/EVALUATION.md), [docs/VERSION_CHOICE.md](docs/VERSION_CHOICE.md),
[docs/RCA_STATISTICAL_REPORT.html](docs/RCA_STATISTICAL_REPORT.html).

## Architecture

```
 EC2 / Docker hosts
        │  SSH, read-only (docker stats, docker ps, /proc/net/tcp)
        ▼
 server/  graph service  :3001  ── discovery, metrics, dependency graph, traffic control, REST + WebSocket
        │  GET /api/graph (nodes, metrics, edges)              ▲ GET /api/incidents
        ▼                                                      │ (prefers the core; falls back to the rule engine)
 core/    analysis core  :8000  ── preprocessing → detect → blame → cascade risk → incidents
        ▲
 client/  React + 3D UI  :5173  ── talks only to the graph service (vite proxies /api and /ws)
```

The core never opens its own SSH connection: it reads what the graph service already collected. If the core is not running, the UI keeps
working on the older rule-based incidents.

## Repository layout

| folder | what it is |
|---|---|
| `core/` | **All analysis logic.** `preprocessing/` (data preparation), `algo.py` (pure algorithms), `ml/` (anomaly-model pipeline), `evaluation/` (bench and statistics), `live.py` + `incidents.py` + `service.py` (the live path). See [core/README.md](core/README.md). |
| `server/` | Graph service (Node/TypeScript): SSH discovery, metrics, the dependency graph, REST API. |
| `client/` | The UI (React, 2D and 3D views). |
| `traffic-gen/`, `remote-collector/` | Load generator and optional push collector, used by the graph service. |
| `scripts/` | `doctor.mjs` (setup check), telemetry export, `e2e_core_bridge.py` (end-to-end check without any servers). |
| `docs/` | Evaluation, version choice, graph-service guide, wiki, the statistical report. |
| `archive/` | Everything that is no longer part of the product, **not connected to anything**: the first lab (`lab-v1/`), duplicate or generated folders, old docs. |

Test targets live in their own repositories: [bench-1](https://github.com/Royson-salis-18/bench-1) (ShopFlow) and
[bench-2](https://github.com/Royson-salis-18/bench-2) (LedgerLine), each with fault scenarios and written ground truth.

## Run it

Requirements: Node 22, Python 3.9+.

```bash
npm run install:all                      # Node dependencies (root, server, client, traffic-gen, remote-collector)
pip install -r requirements.txt          # Python dependencies for core/
mkdir -p server/data && cp server/config/remote_config.example.json server/data/remote_config.json   # then edit: your host IP and key path
npm run dev:core                         # graph service :3001, UI :5173, core :8000
```

Open http://localhost:5173. Keys (`*.pem`) stay on your disk and are never committed.

**Start the system healthy.** The alarm threshold is calibrated on the first 30 minutes of history, and a fault that begins inside that window
and outlasts the 3-minute hold-out can be under-scored (a stopped container is exempt). Until 30 minutes exist the threshold is held at 4.0.

## Tests

```bash
python -m pytest core/tests -q           # algorithms, the report's numbers, the live path (about 12 s)
npm test                                 # graph service (85 tests)
python -m core.evaluation                # recompute the evaluation tables (about 1 min)
python scripts/e2e_core_bridge.py        # graph service -> core -> UI contract, simulated target (needs both running)
```

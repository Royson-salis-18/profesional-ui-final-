# Microservice Mapper — Wiki

This wiki is the complete technical reference for the Microservice Mapper project. Every document reflects the actual codebase — no theoretical descriptions of features that don't exist.

---

## Documents

| # | File | What it covers |
|---|---|---|
| 01 | [overview.md](./01-overview.md) | What the system is, what it isn't, the core philosophy |
| 02 | [architecture.md](./02-architecture.md) | Component map, data flow, ports, persistence |
| 03 | [graphstore.md](./03-graphstore.md) | `GraphStore.ts` internals: data structures, read/write paths, edge heat |
| 04 | [id-system.md](./04-id-system.md) | Canonical IDs, `normalizeId()`, service name derivation |
| 05 | [telemetry-ingestion.md](./05-telemetry-ingestion.md) | `ingestRemote()` — all 8 processing stages with code |
| 06 | [node-edge-lifecycle.md](./06-node-edge-lifecycle.md) | Target status, node pruning, edge status, ghost prevention |
| 07 | [remote-collector.md](./07-remote-collector.md) | Docker socket, log parsing, `/proc/net/tcp`, SSH tunnel |
| 08 | [rca-engine.md](./08-rca-engine.md) | Scoring algorithm, factors & weights, propagation BFS, incident lifecycle |
| 09 | [frontend.md](./09-frontend.md) | React hooks, layout system, component reference, edge visuals |
| 10 | [websocket.md](./10-websocket.md) | Protocol, broadcast, terminal multiplexer, sentinel pattern |
| 11 | [ml-pipeline.md](./11-ml-pipeline.md) | IsolationForest stages, server integration, honest limitations |
| 12 | [data-models.md](./12-data-models.md) | All TypeScript interfaces with field-level annotations |
| 13 | [api-reference.md](./13-api-reference.md) | Full REST API + WebSocket protocol |
| 14 | [configuration.md](./14-configuration.md) | All env vars, config files, data file locations |
| 15 | [troubleshooting.md](./15-troubleshooting.md) | Common issues, known bugs, diagnosis runbook |
| 16 | [change-log-and-rationale.md](./16-change-log-and-rationale.md) | What changed, why, and where — decisions and the bugs behind them |
| 17 | [findings-vs-incidents.md](./17-findings-vs-incidents.md) | Why model output and rule-based alerts are separate pages, and the incident thresholds |
| 18 | [telemetry-tiers-plan.md](./18-telemetry-tiers-plan.md) | Tier 0/1/2 telemetry sources, provenance, and the phased plan |
| 19 | [how-it-all-works.md](./19-how-it-all-works.md) | **Start here.** Plain-language walkthrough, then the full architecture |

---

## Quick Links

- **New to the project / want the whole picture:** [19-how-it-all-works.md](./19-how-it-all-works.md) — plain language first, detail second

- **Understanding the graph:** Start with [01-overview.md](./01-overview.md) → [02-architecture.md](./02-architecture.md)
- **How data flows:** [05-telemetry-ingestion.md](./05-telemetry-ingestion.md)
- **Why nodes disappear:** [06-node-edge-lifecycle.md](./06-node-edge-lifecycle.md) → Node Pruning section
- **Setting up a new target:** [14-configuration.md](./14-configuration.md) → Target SSH Config section
- **Why is it built this way:** [16-change-log-and-rationale.md](./16-change-log-and-rationale.md)
- **Traffic won't start / no edges appear:** [16 §5](./16-change-log-and-rationale.md#5-traffic)
- **"Why does edge X show grey?":** [09-frontend.md](./09-frontend.md) → Edge Visualization Semantics
- **Debugging no metrics:** [15-troubleshooting.md](./15-troubleshooting.md)
- **RCA scoring explained:** [08-rca-engine.md](./08-rca-engine.md) → Scoring Algorithm
- **ML anomaly detection:** [11-ml-pipeline.md](./11-ml-pipeline.md)
- **"Why did this incident fire?" / tuning thresholds:** [17-findings-vs-incidents.md](./17-findings-vs-incidents.md) → Incidents: the rules
- **Where did the ML charts go:** [17-findings-vs-incidents.md](./17-findings-vs-incidents.md) → What moved

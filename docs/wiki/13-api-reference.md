# API Reference

Every route below is verified against `server/api/routes.ts` and
`server/traces/TraceRouter.ts`. All paths are prefixed with `/api`, served
from port `3001` by default.

> Traffic generation has its own control-plane server on port `4400`
> (`traffic-gen/server.js`). Those routes are listed at the bottom under
> [Traffic-gen control plane](#traffic-gen-control-plane); the mapper proxies
> to them rather than reimplementing them.

---

## Graph and nodes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/graph` | Whole graph: `{ nodes, edges, targets }`. Every project combined — filter client-side by `node.project`. |
| GET | `/api/nodes/:id` | One service node. `:id` is the full `project:service` id, e.g. `sock-shop:catalogue`. |
| GET | `/api/nodes/:id/metrics` | Metric history. Query: `range` (default `5m`). |
| GET | `/api/nodes/:id/logs` | Container logs over SSH. Query: `tail` (default 200, max 2000). 404 if the node has no known container id. |
| GET | `/api/analytics` | Derived graph analytics (centrality, criticality). |
| GET | `/api/diagnostics` | Per-target node/edge counts. |
| GET | `/api/status` | Server status summary. |
| GET | `/api/traffic` | Recent interaction events. Query: `limit` (default 100). |

### Edge shape worth knowing

`edge.metrics` is `null` for every edge in a Docker/SSH deployment — nothing
collects HTTP-level latency or error rates. The real per-edge signal is:

```jsonc
"activity": {
  "samplesPerMin": 412.5,  // socket observations/min, NOT new connections
  "windowSec": 118,
  "lastSeen": "2026-09-18T…"
}
```

Absent entirely until a link has been observed at least once — it is never
defaulted to `0`, because "never seen" and "measured as idle" are different
claims. See [06-node-edge-lifecycle](06-node-edge-lifecycle.md).

---

## Targets and discovery

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/targets` | All configured targets. |
| GET | `/api/targets/:targetId/diagnostics` | One target plus node/edge counts. |
| GET | `/api/targets/:targetId/discovery` | Discovery summary for a target. |
| GET | `/api/targets/:targetId/services` | Services in the endpoint registry. |
| GET | `/api/targets/:targetId/endpoints` | Endpoints. Query: `publicOnly=true`. |
| GET | `/api/targets/:targetId/routes` | Routes. Query: `serviceId`, `endpointId`. |
| GET | `/api/targets/:targetId/resolved-url` | The URL traffic would use. Query: `endpointId`. |
| GET | `/api/targets/:targetId/reachability` | Live reachability probe. |
| POST | `/api/discovery/refresh` | Re-run discovery. Body: `{ targetId }`, or omit for all targets. |
| POST | `/api/ingest` | Telemetry ingestion endpoint (used by the remote collector). |

---

## Configuration

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config/remote` | All target connection config. |
| POST | `/api/config/remote` | Add/update a target. Body: `{ targetId, projectName, ec2PublicIp, sshKeyPath, sshUsername, composeFilePath }`. |

**Merge semantics matter here.** This handler merges onto the existing entry
rather than replacing it, because the record also holds keys the edit form
never sends — notably `trafficBaseUrl`. Replacing wholesale silently erased
the pinned traffic entry point every time someone updated an IP.

---

## Traffic control

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/traffic/health` | Is traffic-gen reachable, and what is running per project. |
| GET | `/api/traffic/status` | Per-target run status, joined with the active experiment. |
| POST | `/api/traffic/start` | Start traffic. Body: `{ targetId, profile, mode, routeId, serviceId, endpointId, baseUrl }`. |
| POST | `/api/traffic/stop` | Stop traffic. Body: `{ targetId }` or `{ targetId: 'all' }`. |
| GET | `/api/traffic/entrypoints` | Pinned vs resolved entry point per target, plus a `staleHost` warning when a pin no longer matches the target's current IP. |
| POST | `/api/traffic/entrypoint` | Pin an entry point. Body: `{ targetId, url }`. Empty `url` clears the pin and falls back to discovery. |
| POST | `/api/traffic/entrypoint/probe` | Check a URL responds before committing to it. Body: `{ url, path }`. Returns `{ reachable, status, ms }`. |

**`stop` with `targetId: 'all'` queries traffic-gen for the authoritative list
of running projects** rather than only stopping what this server instance
started. Runs launched directly against traffic-gen, or that outlived a
server restart, were previously invisible to it and survived "stop all".

**Why entry points can be pinned:** discovery can only report what a
container *publishes*, which is not the same as what is *reachable from
here*. A DeathStarBench box publishes nginx-thrift on `:8080`, but if that
port is closed in the security group the inferred URL times out forever while
the working entry point is an SSH forward on `localhost`. Pinning records a
fact discovery cannot observe.

---

## Experiments

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/experiments` | Experiment records. Query: `targetId`. |
| POST | `/api/experiments/start` | Start an experiment. |
| POST | `/api/experiments/update_stats` | Push stats into a running experiment. |

Records still marked `RUNNING` when the store loads are reconciled to
`INTERRUPTED` — nothing survives a process restart, so a `RUNNING` record on
load describes a run that is definitively over. They are marked, not deleted,
so history stays intact.

---

## ML pipeline

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ml/status` | All four stage summaries plus live scores. |
| GET | `/api/ml/config` | Current `ml/config.json`. |
| POST | `/api/ml/config` | Update config. Validated; see below. |
| GET | `/api/ml/models` | Per-model metadata from `models/*.meta.json`. |
| GET | `/api/ml/features` | Recent rows of `features.csv`. Query: `serviceId`, `limit` (max 2000). |
| GET | `/api/ml/normalization` | Per-service mean/std used for z-scoring. |
| GET | `/api/ml/score-history` | Scores over time. Query: `serviceId`, `limit` (max 2000). |
| GET | `/api/ml/retrain` | Status of the current/last retrain. |
| POST | `/api/ml/retrain` | Run `preprocess.py` then `train.py`. Body: `{ since, until }` to restrict the training window. |
| GET | `/api/ml/processes` | State of `collector.py` and `score.py`. |
| POST | `/api/ml/processes/:name/start` | Start `collector` or `scorer`. |
| POST | `/api/ml/processes/:name/stop` | Stop `collector` or `scorer`. |

Config validation: all numeric keys must be positive; `contamination` must be
`< 0.5` (an IsolationForest requirement); `holdout_fraction` must be `0 ≤ x <
0.5` (0 is legal — train on everything); `feature_columns` must be a
non-empty subset of the four `z_*` features.

Process control reports instances started **outside** the app too, detected
with an anchored `pgrep`. Without the anchor the match also hits shell
wrappers whose command line merely contains `python3 collector.py`, and
stopping the wrapper would leave the interpreter running.

---

## Incidents and RCA

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/incidents` | Active incidents. Query: `targetId` for one target. |
| GET | `/api/incidents/:id` | One incident. |
| GET | `/api/incidents/:id/timeline` | Its anomaly timeline. |
| GET | `/api/incidents/:id/evidence` | Its evidence entries. |
| GET | `/api/incidents/:id/propagation` | Its propagation path. |
| GET | `/api/services/:id/anomalies` | Anomalies affecting one service. |

---

## Traces

Mounted at `/api/traces`. **These take `targetId` as a query parameter, not a
path segment.**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/traces/status` | Collection status. Query: `targetId`. |
| GET | `/api/traces/events` | Connection events. Query: `targetId`, `since`, `limit`. |
| GET | `/api/traces/graph` | Aggregated connection graph with `eventCount` per edge. Query: `targetId`, `windowSec` (default 300). |
| POST | `/api/traces/start` | Start trace collection. |
| POST | `/api/traces/stop` | Stop trace collection. |

---

## Traffic-gen control plane

Separate server on port `4400`, started alongside the app.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/targets` | Known workflow targets. |
| GET | `/api/projects` | Every project with live run state and stats. |
| POST | `/api/projects` | Register a project. |
| POST | `/api/discover` | Discover endpoints for a target. |
| POST | `/api/probe` | Probe candidate endpoints. |
| POST | `/api/start` | Start a run. |
| POST | `/api/update` | Change a running run's settings. |
| POST | `/api/stop` | Stop a run. Body: `{ projectId }`. |
| GET | `/api/stats` | Current stats. |

A target whose workflow module exports `STUB: true` is **rejected** by
`/api/start` unless the request supplies confirmed endpoints
(`useDiscoveredEndpoints` plus a non-empty `endpointPaths`). This is why a
new target can fail with HTTP 400 while looking correctly configured — see
[15-troubleshooting](15-troubleshooting.md).

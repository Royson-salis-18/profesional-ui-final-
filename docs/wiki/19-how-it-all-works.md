# 19 — How it all works

Two passes over the same system. **Part 1** is the plain-language version —
no jargon, read it first. **Part 2** is the real architecture with file paths,
intervals and data shapes.

Accurate as of 2026-09-24.

---

# Part 1 — The plain version

## The one-sentence version

You give it an SSH key to a server running Docker containers. It logs in,
looks around, works out which services exist and which ones talk to each
other, watches them, generates traffic against them, and tells you when
something looks wrong — **without installing anything on that server**.

## The doctor analogy

Think of a doctor examining a patient who cannot be opened up.

| The doctor | This system |
|---|---|
| Takes pulse and temperature from outside | Reads CPU and memory from the kernel's own accounting (`docker stats`) |
| Listens for which organs are active | Watches which containers have network connections open to each other |
| Asks the patient to walk on a treadmill | Sends synthetic traffic and watches what happens under load |
| Learns what *normal* looks like for **this** patient | Trains an anomaly model per service on its own history |
| "Your temperature is 39°C — that's a fever by any standard" | **Incidents**: fixed rules on live numbers |
| "This is unusual *for you*" | **Findings**: what the trained models say |
| Reads the patient's own fitness tracker if they wear one | **Tier 2**: reads the target's own Prometheus if it has one |

The last row is the important recent addition. Most patients don't wear a
fitness tracker, so the doctor must work from the outside. But if one
*does*, ignoring it would be silly — you just have to be clear about which
readings came from which source.

## The five things it does

**1. Find out what's there.** Logs in over SSH, runs `docker ps`, reads the
compose file. Now it knows there are 25 services called cart, checkout,
payment and so on.

**2. Work out who talks to whom.** Two separate kinds of evidence, never
mixed up:

- **Declared** — the compose file *says* checkout depends on payment. That's
  a claim on paper. Drawn as a dim grey line.
- **Observed** — we actually caught an open network connection between them.
  That's a fact. Drawn as a bright line, coloured by how busy it is.

This distinction is the backbone of the whole design. The system will never
tell you two services talk because their *names* look related.

**3. Watch them.** Every 5 seconds it collects CPU, memory, network bytes and
a snapshot of open connections for every container.

**4. Poke them.** A traffic generator sends real HTTP requests so there's
something to observe. Idle services produce no signal. It first *probes* to
find which endpoints actually answer, then drives load only at those.

**5. Say when something's wrong.** Two independent opinions, deliberately
kept apart:

- **Incidents** — rules. "CPU is above 85%" or "this is 2.5 standard
  deviations from its own recent baseline". Works immediately, on any
  target, needs no setup.
- **Findings** — machine learning. Four different detectors, each trained
  per service on its own history. Needs training data and a running scorer.

## Why two opinions instead of one

Because they fail differently, and because of honesty.

A **rule** misses a slow drift that never crosses 85%. A **model** misses a
failure that was happening throughout training, because to the model that
*is* normal.

The honesty part matters more for the research. If incidents were raised by
the models, then any test of "how good are these models?" would be graded
against alarms the models themselves raised. The models would be marking
their own homework. Keeping rules independent gives you something to compare
*against*.

## What it genuinely cannot do

From outside a container you can see **how much** work it's doing. You
cannot see **what** the work was.

CPU, memory and network bytes are exact. But there is no way to extract
"this request took 82 ms and returned a 500" from `docker stats` and a
socket table — requests simply aren't in there. That's physics, not a missing
feature.

**Unless the target already measures itself.** The OpenTelemetry demo runs
its own Prometheus with exact latency histograms. We were ignoring it and
scraping sockets instead. Now, if a target publishes that data, we read it —
and every number is labelled with where it came from, so a rough outside
estimate is never mistaken for an exact internal measurement.

## The three tiers, plainly

| Tier | Where the number comes from | Works on |
|---|---|---|
| **0** | Looking from outside (CPU, memory, sockets) | Anything with SSH + Docker |
| **1** | Reading the gateway's own request log | Targets whose proxy logs requests |
| **2** | Asking the target's own Prometheus | Targets that already instrument themselves |

Tier 0 always works and is the fallback. Tiers 1 and 2 are better when
available. Of the four current targets, only one has Tier 2.

## Why the models currently say very little

An honest caveat. The detectors mostly report nothing, and it isn't the
algorithms' fault — it's the data.

`sock-shop:front-end` has **1568 training rows containing 6 distinct
values**. An idle container's CPU barely moves, and we sample it faster than
it changes, so we record the same reading hundreds of times. You cannot
learn a boundary from six points no matter how many times you write them
down.

That's why Tier 1/2 matters beyond fidelity: latency and error rate actually
*vary*. They would give the models something to learn from.

---

# Part 2 — The detailed picture

## Processes

Three, plus optional Python.

```
┌─────────────────┐   REST + WebSocket   ┌──────────────────────────┐
│  React client   │◄────────────────────►│  Node server  :3001      │
│  Vite  :5173    │                      │                          │
└─────────────────┘                      │  GraphStore (in memory)  │
                                         │  MetricStore (ring buf)  │
┌─────────────────┐   HTTP :4400         │  TraceStore (per target) │
│  traffic-gen    │◄────────────────────►│  EndpointRegistry        │
│  Node, separate │                      │  IncidentManager         │
└────────┬────────┘                      └────────┬─────────────────┘
         │ HTTP load                              │ SSH (ssh2)
         ▼                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  TARGET: EC2 box running Docker Compose                          │
│  docker ps / inspect / stats · /proc/<pid>/net/tcp · logs        │
│  optionally: its own Prometheus :9090, Jaeger :16686             │
└──────────────────────────────────────────────────────────────────┘

    ml/  ── collector.py → preprocess.py → train.py → score.py
            (separate Python processes, started from the UI)
```

## The collection cycle

One `TargetAgent` per target, in `server/discovery/EndpointDiscoveryEngine.ts`.

```
runCycle()
  ├── connect over SSH (ConnectionManager, ssh2)
  ├── restartCrashedContainers()   ← on reconnect only
  ├── refreshDiscovery()           ← docker ps + compose parse
  └── startPolling()               ← then every 5s, self-scheduling
        ├── MetricCollector.collectOnce()
        │     ├── docker stats            → CPU/memory/network
        │     ├── docker inspect          → container IP map
        │     ├── /proc/<hostPid>/net/tcp → observed edges + connections
        │     └── docker logs             → HTTP interactions (Tier 1)
        ├── collectRequestMetrics()       ← Tier 2, opt-in, wrapped
        └── onTelemetryCollected(envelope) → GraphStore.ingestRemote()
```

**Self-scheduling, not `setInterval`.** A cycle takes far longer than 5s
(25 services × one SSH exec each). `setInterval` fired regardless, so cycles
overlapped and exhausted the SSH server's `MaxSessions`. Measured: 2.66
refused scans per cycle before, **0.00 after**.

**Socket reads come from the host, not the container.** `docker exec <id> sh
-c 'cat /proc/net/tcp'` fails on any image without a shell — the OTel demo's
frontend is distroless, so its scan failed 100% of the time, silently. It
now reads `/proc/<hostPid>/net/tcp` from the host, which needs nothing
inside the container.

## The graph

`server/graph/GraphStore.ts`. Node ids are `project:service`
(`open-telemetry:cart`), which is what keeps projects from ever mixing.

**Edges carry evidence, not just existence:**

```ts
declared: boolean        // a config file said so
observed: boolean        // a live TCP connection was seen
evidenceSources: string[]// compose, network-tcp, nginx-config, ...
activity?: {             // socket observations per minute
  samplesPerMin: number  // NOT requests — deliberately named
  windowSec: number
}
metrics: { p95Latency, errorRate, requestRate, provenance } | null
```

`metrics` is `null` under Tier 0 and that is correct, not a gap. `activity`
is the Tier 0 volume proxy and is named so it can't be read as a request
rate.

**Stale handling.** Nodes prune after 15 minutes unseen
(`STALE_NODE_MS = 900_000`); re-discovery returning 0 services keeps the
previous set, because that is almost always a transient SSH failure.

## Traffic generation

Separate Node service on `:4400`, so load is never generated from inside the
server that is measuring.

```
UI → POST /api/experiments/start
       → TrafficController.startTarget()
           ├── resolveBaseUrl()        pinned → discovered → target base
           ├── probeSurface()          two-phase, if mode = SWEEP
           └── POST :4400/api/start    users, profile, endpointPaths
```

**`probeSurface` is two-phase** because one is not enough:

1. **Origins** — one request per discovered `host:port`. On the OTel demo
   this eliminated 19 of 20: only `:8080` is open in the security group.
2. **Paths** — for each origin that answered, probe paths behind it. A
   gateway fans one open port to every backend by path, so stopping at
   phase 1 reports "1 endpoint works" for a 25-service system.

Path candidates come from the target's **own workflow file** first
(`GET /api/targets/:id/paths`), then generic conventions. DeathStarBench's
API is `/wrk2-api/*`; generic guesses produced 49 404s out of 53, while its
workflow had the real paths all along.

Timeouts adapt: phase 2 scales off the slowest origin and retries anything
that only *timed out* at 25s. Sock-shop went from "23 of 41 dead" to
**0 dead, 11 usable** — they were alive, just slower than a flat 6s budget.

## The ML pipeline

Four Python scripts in `ml/`, driven from the UI.

```
collector.py   every 10s → data/metrics_raw.csv
preprocess.py  → z-score normalise per service → data/features.csv
train.py       per service × 4 detectors → models/<svc>.<algo>.joblib
score.py       every 10s → data/latest_scores.json
```

**Four detectors, deliberately different families** so that agreement
carries information:

| | method | note |
|---|---|---|
| `iforest` | partitioning | the default |
| `lof` | local density | refuses below 20 distinct rows |
| `ocsvm` | boundary | fits a frontier |
| `zscore` | statistical | no fitting; the baseline the others must beat |

All score *higher = more anomalous*, each with its own p99 threshold from
its own training distribution.

**LOF refuses rather than lies.** Fitted naively it produced thresholds of
`3.37e9`, because with 1568 rows holding 47 distinct values a point's 20
nearest neighbours are 20 copies of itself and local density goes to
infinity. It now fits on distinct rows and refuses below 20 of them.

**Training is per project** (`--project`), and the summary merges rather
than overwrites so training one project doesn't blank the others.

## Incidents vs Findings

| | Incidents | Findings |
|---|---|---|
| Code | `server/rca/` | `ml/` + `FindingsView` |
| Method | fixed z-score + absolute thresholds | four trained detectors |
| Needs | a metric history | training data + scorer running |
| Works untrained? | yes | no |
| Config | `data/incident_thresholds.json` | `ml/config.json` |

`server/rca/` imports nothing from `ml/`. All ten incident rules are
editable in the UI, clamped to safe ranges, re-read each pass.

## Telemetry tiers

`server/models/MetricProvenance.ts` records where every number came from,
and `SOURCE_CAPABILITIES` enforces what each source may claim — a socket
scan cannot populate a latency field.

Tier 2 is opt-in per target:

```json
"telemetrySources": { "prometheus": { "enabled": true, "url": "http://localhost:9090" } }
```

`localhost` is correct: the query runs *on the target* via curl over the
existing SSH connection, because Prometheus is bound to localhost there.

The whole Tier 2 path is wrapped — a broken optional source logs once and
returns empty, and the merge is additive so a failed cycle never wipes the
Tier 0 metrics collected in the same cycle.

## Performance notes

Two measured fixes worth remembering:

**Tail-reading beats full-reading.** `/api/ml/features` returns the most
recent 300 rows and was reading all 33 MB to do it: 114.9 ms reading,
26.1 ms splitting into 152k strings, **0.3 ms** doing the actual work.
`util/tailCsv.ts` seeks backwards from EOF and stops when it has enough —
**194 ms → 2.0 ms**, byte-identical output.

**Cost should track the answer, not the history.** These files only grow.
Anything proportional to total history degrades on its own over time.

## The pages

| Page | Shows |
|---|---|
| 3D Vision | the graph in 3D, spatial layouts, click for details |
| Architecture | the same graph in 2D |
| Telemetry | live per-service metrics + raw traffic feed |
| Dependencies | edges with their evidence |
| Analytics | graph-level analysis |
| ML Pipeline | the machine: processes, execution, config, progress |
| **Findings** | what the models concluded |
| Traces | observed connection events |
| **Incidents** | rule-based alerts + editable detection rules |
| Experiments | traffic run history |

## Where to read next

- Evidence model and edge lifecycle → [06](./06-node-edge-lifecycle.md)
- RCA scoring → [08](./08-rca-engine.md)
- Findings vs Incidents in full → [17](./17-findings-vs-incidents.md)
- Telemetry tiers plan → [18](./18-telemetry-tiers-plan.md)
- Why things are built this way → [16](./16-change-log-and-rationale.md)

# Telemetry Platform — Phase 1 + Phase 2

Standalone data collection / cleaning / feature-engineering / analytics
pipeline for a microservice observability platform. This is the **data
engineering layer**, independent of any UI, RCA, or anomaly detection.

This repo implements **Phase 1** (schemas, config, connection, storage,
CLI skeleton) and **Phase 2** (architecture discovery: host metadata,
Docker container inventory, service classification, declared/candidate
dependencies), per the project spec's phased rollout. Later phases
(metrics/log collection, normalization, feature building, analytics,
graph, export) are intentionally not built yet — see "What's next" below.

## Why Phase 1 first

Everything downstream (metrics, logs, interactions, features, graph)
depends on three things being solid: how we identify a target/service
(schemas), how we talk to a target (connection), and where evidence
lives (storage). Building those first, and testing them without needing
live AWS access, means every later phase can be built and tested the
same way.

## File tree

```
telemetry-platform/
  package.json
  tsconfig.json
  src/
    types/
      target.ts          # Target, connection, collector, storage config shapes
      service.ts          # Service + Dependency models (declared vs observed)
      metrics.ts            # ContainerMetricSample (null = missing, never 0)
      logs.ts                 # LogEvent
      interactions.ts          # InteractionEvent (only ever built from real evidence)
      architecture.ts            # HostMetadata + ArchitectureInventory (Phase 2 output)
    connection/
      RemoteCommand.ts    # Auditable, bounded, sanitized command registry
      Connection.ts        # Transport-agnostic interface
      SSHConnection.ts       # Real ssh2-backed implementation
      FakeConnection.ts        # In-memory implementation for tests
      ConnectionManager.ts       # Lifecycle + retry/backoff per target
    config/
      loadTarget.ts               # target.yaml loader + validator
    storage/
      StorageManager.ts             # Layered JSONL/JSON storage (raw/normalized/...)
    discovery/
      DiscoveryEngine.ts             # Orchestrates Phase 2 end-to-end
      serviceIdentity.ts               # Stable serviceId derivation
      classifyService.ts                 # Multi-evidence service type classifier
      parsers/
        dockerPs.ts                        # `docker ps` JSON-lines + labels + ports
        dockerInspect.ts                     # `docker inspect` -> networks/labels/state
        composeDependsOn.ts                    # Best-effort docker-compose depends_on
    cli/
      index.ts                       # `collector check-connection` / `init-storage` / `discover`
  tests/
    config.test.ts
    connection.test.ts
    storage.test.ts
    dockerParsers.test.ts
    serviceIdentity.test.ts
    discoveryEngine.test.ts
  examples/
    target.example.yaml
  data/                                 # created by init-storage/discover, per-target
    raw/ normalized/ cleaned/ features/ graph/ analytics/
```

## Interfaces built so far

- **`TargetConfig`** — the generic shape any environment is described
  by. New targets are added by writing a `target.yaml`, not by copying
  code (spec §3, §59).
- **`RemoteCommand<T>`** — every SSH command is a named, timeout-bound,
  output-capped, parsed object. Identifiers (container IDs, network
  names) passed into command builders are validated against a strict
  allow-list regex before being interpolated — no raw shell strings
  from user input (spec §5).
- **`Connection`** — transport-agnostic. `SSHConnection` is the real
  implementation (ssh2, key read from disk, never logged). `FakeConnection`
  is a deterministic in-memory stand-in used by all current tests, so
  **no test requires live AWS/SSH access** (spec §53).
- **`ConnectionManager`** — owns connect/retry/backoff/disconnect for a
  target; safe to call repeatedly from a future background loop (spec §4).
- **`StorageManager`** — six fixed layers (raw/normalized/cleaned/features/graph/analytics),
  one JSONL file per logical dataset (services/metrics/logs/...), append-only,
  plus `writeJson`/`readJson` for single documents like `graph.json` (spec §22, §23, §43).
- **`Service` / `Dependency`** — `Dependency.declared` and
  `Dependency.observed` are separate booleans; nothing in Phase 1 ever
  sets `observed = true` without evidence, because the discovery/interaction
  engines that would produce that evidence don't exist yet (spec §9, §61).

## Phase 2: what discovery actually produces

`DiscoveryEngine.discover()` runs:

1. Host metadata (`hostname`, `uname -a`, remote UTC time, `docker version`).
   If Docker isn't reachable, this is the only thing returned — service/
   dependency discovery is skipped, not silently faked (spec §48).
2. `docker ps --no-trunc --format '{{json .}}'` → one container per JSON line
   (unparseable lines are counted and skipped, not fatal).
3. `docker inspect <id>` per container → real network membership, IP
   addresses, restart count, labels, mounts.
4. **Service identity**: `serviceId = "<targetId>:<name>"`, where `<name>`
   prefers the `com.docker.compose.service` label, then strips a
   compose project prefix + replica suffix from the container name
   (`sockshop_orders_1` → `orders`), then falls back to the raw name.
   Deterministic — never depends on container IDs or process state.
5. **Classification**: `classifyService()` scores a service against
   image/name/port signals across all 12 spec categories and returns
   both the winning type *and* the list of evidence strings that led
   there — so "why is this a database?" is always answerable.
6. **Dependencies — two separate, clearly-labeled sources**:
   - *Network-candidate edges*: any two services sharing a Docker
     network get a `Dependency` with `declared: false, observed: false,
     evidenceSources: ["docker-network"]`. This is explicitly **not**
     proof of communication — it's "these two could reach each other,"
     kept only so the interaction-extraction phase later has candidates
     to check against real log/trace evidence.
   - *Compose-declared edges*: if a container's compose project points
     at a readable compose file, `depends_on` relationships are parsed
     and recorded as `declared: true, evidenceSources: ["compose"]`.
     This step is best-effort — a missing/unreadable file produces a
     warning, not a failed discovery run.

Output: `architecture.json` (host + summary + warnings), `services.json`,
`dependencies.json`, written to `<outputDirectory>/raw/`.

## Data flow (Phase 1 + 2 slice)

```
target.yaml
   │  loadTargetConfig()
   ▼
TargetConfig
   │  new ConnectionManager(target)
   ▼
ConnectionManager.getConnection()  ──(retry+backoff)──►  SSHConnection.connect()
   │
   ▼
connection.execute(REMOTE_COMMANDS.hostname())  ──►  RemoteCommandResult
   │
   ▼
StorageManager(target.storage.outputDirectory)
   │  writeJson("raw", "target.json", target)
   ▼
data/<target-id>/raw/target.json
```

Nothing here parses Docker output, collects metrics, or builds
features yet — that starts in Phase 2/3.

## CLI (what actually works today)

```bash
npm install
npm run build

# Validate a config and open a live connection, run 3 sanity commands
node dist/cli/index.js check-connection --target examples/target.example.yaml

# Create the layered storage directories + dump the resolved target config
node dist/cli/index.js init-storage --target examples/target.example.yaml

# Discover architecture: host info, containers -> services, dependencies
node dist/cli/index.js discover --target examples/target.example.yaml
```

`collect`, `build-dataset`, `analytics`, `export` are present in the
CLI's command list but intentionally exit with a "not implemented yet"
message — they belong to later phases.

## Tests

```bash
npm test
```

```
✓ tests/discoveryEngine.test.ts  (2 tests)
✓ tests/dockerParsers.test.ts    (8 tests)
✓ tests/connection.test.ts       (8 tests)
✓ tests/serviceIdentity.test.ts  (10 tests)
✓ tests/storage.test.ts          (5 tests)
✓ tests/config.test.ts           (3 tests)

Test Files  6 passed (6)
     Tests  36 passed (36)
```

All tests run against `FakeConnection` and temp directories — no AWS
or SSH access required, per spec §53.

## Known assumptions (flag these before Phase 2)

1. **Only SSH connections are modeled.** The spec only asked for SSH,
   so `ConnectionConfig` is a union of one member today; adding a
   second transport later means adding a branch to `ConnectionManager.buildConnection`,
   not changing the `Connection` interface.
2. **Command sanitization is allow-list-based and intentionally strict**
   (`[a-zA-Z0-9_.-]+` for container/network identifiers). If real
   container names in your Docker Compose stacks use characters outside
   that set, `sanitizeContainerId` will reject them — safer to find that
   out now than to loosen it silently later.
3. **`docker.ps` / `docker.stats` / `docker.inspect` parsers are not
   implemented yet** — Phase 1 only defines the command + timeout +
   output cap; turning their JSON-lines stdout into typed `Service`/
   `ContainerMetricSample` objects is Phase 2/3 work.
4. **No background/scheduled loop yet.** `ConnectionManager` is
   loop-safe (idempotent `getConnection()`, explicit `close()`), but
   the actual "poll every N seconds" driver is part of Phase 7's
   collection loop (spec §47), not Phase 1.
5. **`application` adapter config (Sock Shop / Vertikal) is just a
   typed pass-through today** (`knownServices` list). The adapters that
   *use* this to aid classification/discovery are Phase 13/14 work.

## What's next (in spec order — not started)

- **Phase 2** — Architecture discovery (`docker ps`/`inspect`/`network inspect`
  parsers → `Service[]` + declared `Dependency[]` → `architecture.json`).
- **Phase 3** — Docker metrics collection + CPU delta math → `ContainerMetricSample[]`.
- **Phase 4** — Bounded/incremental log collection.
- **Phase 5** — Log parser registry (Nginx/Traefik/generic HTTP/JSON) → `InteractionEvent[]`.
- **Phase 6–12** — Normalization/validation, time-windowed feature
  datasets, descriptive + graph analytics, export, quality reports.
- **Phase 13/14** — Sock Shop and Vertikal adapter validation against real targets.

This is also where the **UI / graph visualization** you asked about
belongs conceptually: this project's own spec (§(top), §63) is explicit
that *no UI is built in this pipeline* — the pipeline's job is to
produce `graph.json` (nodes + edges with degree/centrality/request/error
annotations, spec §42) as a stable, versioned artifact that a separate
frontend (your existing Microservice Mapper / React app) consumes. So
"telemetry collector" continues here in this repo (Phases 2–12); "UI
graph generator" is a separate frontend project that reads `graph.json`
+ `service_features.csv` — happy to scope that as its own piece once
you tell me what it should render with (React Flow? Cytoscape? d3?) and
whether it's the same app your traffic-gen dashboard already lives in.

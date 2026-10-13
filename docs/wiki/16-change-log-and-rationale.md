# Change Log and Rationale

A record of what was changed, **why** it was changed, and **where** it lives.
Written so a future reader can tell the difference between a deliberate
decision and an accident, and can safely undo something without rediscovering
the problem it solved.

Entries are grouped by area. Each one states the symptom first, because the
symptom is what you will be looking at when you come back to this.

---

## 2026-10-08: RCA and target-status correctness fixes (commit e66d261)

**Symptoms.** (1) In an incident, the service that called the broken one was named as root cause. (2) Incidents raised by CPU/memory anomalies on running services showed no root cause. (3) The propagation path pointed from the cause to its dependencies. (4) A `docker pause`d container never appeared in incidents. (5) sock-shop and train-ticket showed **LIVE** with 0 services discovered.

**Causes and fixes.**
* `server/rca/RCAEngine.ts`: the +0.15 "downstream correlation" bonus rewarded a service whose callee failed, i.e. a victim. Replaced by a -0.25 victim penalty and a +0.15 bonus for a service whose callers fail while its callees are healthy. Candidates now include anomalous running services. Propagation walks to callers. Precedence weight 0.30 -> 0.10; observed-edge bonus removed from the score.
* `server/rca/AnomalyDetector.ts`: robust baseline (median, 1.4826 x MAD) from history before the two judged samples; both samples must deviate the same way (persistence); missing readings skipped instead of read as 0; paused containers raise `container-paused`.
* `server/collectors/DockerCollector.ts`: `State === 'paused'` -> status critical (was `unknown`).
* `server/graph/GraphStore.ts`: an HTTP ping of the app's website no longer refreshes `lastSeen` (it said nothing about telemetry), and a discovery that found zero services no longer marks the target LIVE.

**Evidence.** `tests/rca.test.ts`, 9 tests; 7 fail on the previous code. All 60 tests pass. Background and live measurements: rca-lab `docs/WHAT_IS_WRONG.md` (github.com/Royson-salis-18/new-repo).

**Not fixed (known).** Remote mode has no container state; auto-restart on by default; `server/data/remote_config.json` had stale IPs for death-star and open-telemetry on 2026-10-08.

---


## 1. Discovery and the graph

### 1.1 Discovery ran once and never again

**Symptom:** containers showed as `unknown-<12 hex>` with no type, no edges,
and no way to fix it short of restarting the app.

**Cause:** `runCycle()` ran `DiscoveryEngine.discover()` once per SSH
connection, cached the result, and handed that static snapshot to the 5-second
metric poll forever. A container that restarted onto a new container id no
longer matched anything in the snapshot, so `MetricCollector` fell back to an
ad-hoc `unknown-<hash>` id. Discovery only re-ran if the connection dropped.

**Fix:** a periodic re-discovery timer.
**Where:** `server/discovery/EndpointDiscoveryEngine.ts` — `refreshDiscovery()`,
`rediscoveryTimer`.

**Interval is 180s, deliberately.** A rescan is one `docker ps` plus one
`docker inspect` per container in a burst — far heavier than the ambient
polling. At 60s it pushed SSH channel usage over the edge on a loaded host
and produced `Channel open failure` across the *whole* connection, not just
rediscovery.

### 1.2 A failed rescan wiped a good service list

**Symptom:** after a transient SSH hiccup, every matched service reverted to
`unknown-<hash>` until the next reconnect.

**Cause:** `discover()` returns an empty list on failure **without throwing**,
and the refresh assigned that empty result unconditionally.

**Fix:** keep the previous list when a rescan returns zero services but a
known-good list already exists. Logged, and retried next cycle.
**Where:** `EndpointDiscoveryEngine.refreshDiscovery()`.

### 1.3 Docker command timeouts were sized for a healthy host

**Symptom:** a target silently showed zero services.

**Cause:** discovery returns all-or-nothing on a `docker ps` failure. On a
swap-thrashing 2GB box running ~18 JVM services, `docker ps` was **measured at
45.6s** against a 15s timeout, so discovery failed every cycle.

**Fix:** timeouts raised to match reality — `docker ps` 90s, `inspect` and
`version` 20s, `stats` 30s, container TCP read 10s.
**Where:** `server/telemetry-platform/src/connection/RemoteCommand.ts`.

**No timeout value fixes an out-of-RAM host.** If a target is slow or absent,
check `uptime` and `free -m` on the box before touching code.

### 1.4 Nodes were never removed

**Symptom:** the graph accumulated ghosts. `/api/graph` reported 76 nodes
across three projects when far fewer existed.

**Fix:** `lastSeen` on every node, stamped by discovery and telemetry;
`pruneStaleNodes()` removes anything untouched for `STALE_NODE_MS`, plus any
edge referencing a removed node.
**Where:** `server/graph/GraphStore.ts`, `server/models/ServiceNode.ts`.

**The threshold is 15 minutes, longer than the 5-minute OFFLINE threshold, on
purpose.** SSH channel exhaustion blacks out *all* commands for minutes at a
time on these hosts. Pruning on the OFFLINE clock wiped the entire graph
during blackouts the target recovered from on its own.

Nodes loaded from disk without a `lastSeen` get a **load-time baseline**, so
they get a full grace window to be reconfirmed instead of being judged
infinitely stale on the first tick. An earlier attempt used a flat 30-second
startup grace and deleted every node on a host whose discovery legitimately
takes longer than that.

### 1.5 Dependencies from `application.yml`

**Symptom:** a 17-service Train Ticket stack showed 17 nodes and **zero**
edges.

**Cause:** the only declared-edge source was compose `depends_on`, and that
deployment declares none.

**Fix:** a generic parser that walks any YAML tree and extracts hostnames from
`scheme://host[:port]` values, resolving `${VAR:default}` placeholders (the
default is what applies when the env var is unset, the normal case in a
compose deployment). An edge is emitted **only** when the hostname exactly
matches a discovered service — a hostname matching nothing is discarded
rather than becoming a phantom node.
**Where:** `server/telemetry-platform/src/discovery/parsers/applicationConfig.ts`.

Result on that stack: 19 real edges where `depends_on` parsing found none.

---

## 2. Edges: what the colours mean

### 2.1 Heat is driven by connection activity, not "load"

**Symptom wanted:** busy links should grade yellow → orange → red.

**Constraint found:** `edge.metrics` is `null` on **every** edge in a
Docker/SSH deployment. There is no per-edge latency, error rate, or request
count anywhere in the data. Grading by "load" in the HTTP sense would have
meant inventing numbers.

**What is real:** the per-container `/proc/net/tcp` sweeps. These are rolled
into a per-minute rate per edge.
**Where:** `GraphStore.applyEdgeActivity()`, `DependencyEdge.activity`.

**Named `samplesPerMin`, not `connectionsPerMin`.** The collector re-counts
every `ESTABLISHED`/`TIME_WAIT` socket on each sweep, so one long-lived
connection contributes repeatedly. It is a concurrency proxy, not a count of
new connections — the first name implied a precision the measurement does not
have.

**Thresholds are calibrated against the real spread** (median 112, p75 256,
p90 1774, max 5571 across 47 measured links), not picked arbitrarily. An
initial guess of 200 for "saturated" would have painted almost everything red.

| Band | Threshold | Colour |
|---|---|---|
| calm | ≤ 60/min | cyan |
| busy | 60–250 | yellow |
| heavy | 250–1200 | orange |
| saturated | > 1200 | red |

An explicit `failed`/`degraded` status still outranks volume: a broken link
matters more than a busy one. Links never observed stay inert grey, and links
observed but not yet rated say so rather than reporting `0/min`.
**Where:** `client/src/components/shared/edgeHeat.ts` — shared by both views,
so a link cannot look calm in one and hot in the other.

### 2.2 Colour vocabulary

Warm colours mean trouble, everywhere. Category colours are all cool
(cyan/blue/green/violet/teal); amber and red are reserved for degraded,
critical, failed, and persistent anomalies. Inactive (declared-but-never-
observed) links are dark grey so they recede behind links doing real work.

### 2.3 Edge status is never inherited from nodes

An overloaded node does **not** mark its edges degraded. There is no
edge-level evidence for that claim, so it would be an assertion about a link
based on a measurement of an endpoint. Stale `degraded`/`failed` statuses are
reset when no current edge-level evidence supports them.
**Where:** `GraphStore.ingestRemote()`.

---

## 3. Spatial arrangements

Eight layouts in each view, selectable, persisted to `localStorage`.
**Where:** `client/src/components/3d/layouts.ts` (3D),
`client/src/components/layouts2d.ts` (2D).

### 3.1 Hierarchy hung the browser on cyclic graphs

**Symptom:** selecting Hierarchy froze the tab. Found by a unit test, which
hung with zero output.

**Cause:** the BFS re-queued a node whenever a longer path to it was found, to
get "deepest depender wins". On a cycle — `A → B → A`, which real meshes have
whenever a service and its database are each observed calling the other —
depth grows without bound and the loop never terminates.

**Fix:** breadth-first with first-visit depth, each node assigned once.
Terminates always, still reads left-to-right. Nodes in pure-cycle components
unreachable from any root are placed after the deepest reached node rather
than at zero, where they would sit on top of the entry points.
**Where:** `layouts2d.ts` — `hierarchyDepths()`.

Verified against 200 nodes / 400 edges of pure bidirectional cycles: all
eight layouts complete in ≤1ms.

### 3.2 Layouts wrap

Tiers put every service of one role in a single row — 9,620px of horizontal
pan in 2D, and in 3D a flat line that reads as a wall from any normal camera
angle. Hierarchy did the same vertically (7,030px). Both now wrap into
sub-rows/sub-columns.

### 3.3 Camera fitting (3D)

Each arrangement has a completely different footprint, so one fixed camera
either buries the scene or leaves it a speck.
**Where:** `Scene3D.tsx` — `FitCamera`.

Three things that each caused a blank screen while getting this right, all
now handled:

- **Width and height are fitted separately.** Judging by a single "max
  dimension" against the vertical FOV lets a wide flat ring run off both sides.
- **Fog has to follow the framing distance.** A fixed fog range that looks
  right around a small cluster renders a large ring as an empty screen,
  because the camera pulls back past where fog is fully opaque.
- **Elevation adapts to shape.** A flat layout needs a high angle or it
  collapses edge-on; a tall one needs a low angle or it foreshortens into a
  blob.

---

## 4. 3D scene

### 4.1 Positions are driven imperatively, not through React state

**Symptom:** the entire canvas rendered nothing — no grid, no nodes.

**Cause:** the layout animator called `setState` every frame. That re-rendered
the scene, which rebuilt the layout, which restarted the animation. The loop
starved the render loop badly enough that nothing inside the `Canvas` ever
drew.

**Fix:** a shared mutable `Map<string, THREE.Vector3>` written by a
`useFrame` driver and read by nodes, edges, and labels. No React state in the
frame loop.
**Where:** `Scene3D.tsx` — `LayoutDriver`, `PositionMap`.

### 4.2 Text can blank the whole canvas

**Symptom:** the same total blank, after the above was fixed.

**Cause:** drei's `<Text>` suspends while troika fetches a font. Sharing one
Suspense boundary with the rest of the scene means a slow or hanging font
request takes the grid and every node down with it.

**Fix:** every `<Text>` block sits in its own `<Suspense fallback={null}>`.
**Where:** `Node3D.tsx`, `Scene3D.tsx`.

### 4.3 Links were buried inside the hardware

**Symptom:** Architecture showed many blue links; 3D appeared to show far
fewer. Both views had **identical** data — 50 edges, 17 observed.

**Cause:** links attached at mid-chassis height while chassis tops are taller,
so a link entered one unit, passed through its body, and came out the far
side. 2D always draws edges on top.

**Fix:** links leave from above the hardware and arc enough to clear what they
pass over.
**Where:** `Edge3D.tsx` — `NODE_HEIGHT`, arc height.

Declared-only links had a second problem: they were drawn at 25% opacity in
near-black, so 33 of 50 edges were effectively invisible. They now match the
2D canvas's weighting.

### 4.4 Edges failed to build geometry at the origin

An edge only rebuilt its tube when an endpoint *moved*, compared against a
starting position of `(0,0,0)`. Any edge touching a node genuinely at the
origin — exactly where the Radial layout puts its most-connected service —
measured zero movement on the first frame and **never built geometry at all**.
Now tracked with an explicit `built` flag.
**Where:** `Edge3D.tsx`.

### 4.5 Selection focus

Selecting a unit keeps it and its direct neighbours lit and labelled;
everything else drops to ~15% and stops animating. Deselect works three ways:
click empty space, click the selected unit again, or press Escape.

`onPointerMissed` can fire in the same gesture as a node click, which would
select and instantly deselect — the details panel would flash and vanish. A
150ms guard ignores a "missed" that lands right after a real hit.
**Where:** `Scene3D.tsx`.

---

## 5. Traffic

### 5.1 "Stop all" did not stop all

**Symptom:** traffic kept hitting a target after Stop All reported success.

**Cause:** `stopAll()` iterated only runs *this server instance* started. A
run launched directly against traffic-gen, or one that outlived a server
restart, was invisible to it — and after a restart that map is empty, so Stop
All stopped **nothing**.

**Fix:** query traffic-gen for the authoritative list of running projects and
stop every one. Also removed a hardcoded target allowlist in `stopTarget()`
that let project ids like `vertikal-prod` slip through.
**Where:** `server/traffic/TrafficController.ts`.

### 5.2 Entry points can be pinned

See [14-configuration](14-configuration.md#target-ssh-config--dataremote_configjson).
Short version: discovery reports what a container *publishes*, which is not
what is *reachable*. One box resolved to Jaeger's OTLP `:4318` instead of the
app; another published `:8080` that was closed in the security group.

`POST /api/config/remote` merges rather than replaces, because replacing
erased the pin whenever someone updated an IP.

### 5.3 Traffic only exercises what you point it at

Sock Shop showed nodes but **zero** edges. Its compose file declares no
`depends_on` and it is not Spring, so neither declared-edge source produces
anything — every edge must come from observed TCP. But traffic-gen was running
in discovered-endpoints mode against `/` only, hammering a static homepage
that never calls a backend: 6,365 requests, zero edges.

Running the real `sockshop.js` browse/cart workflows produced real edges
within a minute.

**Caveat recorded in `sockshop.js`:** the `cart` workflow crash-loops that
deployment's front-end (an unhandled error callback at
`/usr/src/app/api/cart/index.js:79` when the carts service errors), turning
everything into 502s. On a box where carts is slow enough to error, run
`browse` only.

### 5.5 "Start experiment does nothing" — five separate causes

Reported as a single symptom on the OpenTelemetry target. Each of these was
independently capable of producing it.

**a) traffic-gen could never be restarted once it died.**
`ensureTrafficGenRunning()` cached its in-flight promise in
`ensureStartingPromise` and **never cleared it**. traffic-gen is spawned as a
child of the mapper, so it dies whenever the parent restarts — after which
every later call returned the stale resolved promise, skipped the respawn,
and every proxied request failed with `fetch failed`. The promise is now
released in a `finally`, and a reachability check short-circuits when it is
already up.
**Where:** `server/traffic/TrafficController.ts`.

**b) The start was fire-and-forget.** `startTarget()` returned
`isRunning: true` immediately, before traffic-gen had accepted or refused.
A refusal (STUB target, 409, process down) was logged to the server console
while the API — and therefore the UI — reported success. It is now `async`
and returns the real outcome; `/api/experiments/start` returns **502** with
the reason and closes the experiment record instead of leaving it RUNNING
against a workload that never ran.

**c) The default entry point was Grafana.** Endpoint ranking sorted PUBLIC
endpoints by lowest port, so an OpenTelemetry Demo resolved to Grafana
`:3000` ahead of the app frontend on `:8080` — and `:3000` was not reachable
from outside, so the reachability gate failed. Observability components are
now ranked last, identified by service name rather than port (ports collide:
`:3000` is Grafana here and an ordinary frontend elsewhere).
**Where:** `server/registry/EndpointRegistry.ts`.

**d) The button failed silently.** `handleStart()` began with
`if (!isEndpointReady || !isSelectedServiceCapable) return;` while the button
was only disabled by `isLoading || isCurrentRunning`. Clicking an
enabled-looking button did nothing and said nothing. The button is now
disabled when blocked, and the panel states which precondition failed.
**Where:** `client/src/components/TrafficControlPanel.tsx`.

**e) Endpoint selection leaked across targets.** Switching the target kept
the previously selected endpoint/service/route ids, which are namespaced per
target — visible in the log as a death-star experiment resolving an
open-telemetry endpoint id, i.e. traffic aimed at the wrong project's URL.
Switching target now clears them.

Verified after the fixes: 104 requests, 104×HTTP 200, 2.53 req/s, p50 33ms
against `http://…:8080`.

### 5.4 Stub targets are rejected by design

A workflow module exporting `STUB: true` is refused by `/api/start` unless the
request supplies confirmed endpoints. This is why a newly added target can
fail with HTTP 400 while looking correctly configured. `opentelemetry.js`
sets `STUB: false` because its paths are the demo's own frontend routes,
with the reasoning recorded in the file header.

---

## 6. Views are split per project

**Symptom:** with "ALL TARGETS" selected, Telemetry/Dependencies/Analytics/
Traces merged every project into one undifferentiated list, and Traces
literally showed only `targets[0]`.

**Fix:** a shared wrapper renders one labelled, collapsible section per
project with a live summary. Selecting a single project is unchanged.
**Where:** `client/src/components/ProjectSections.tsx`, plus an `embedded`
prop on each view so the wrapper owns scrolling and height.

Traces needed a fixed height when embedded: its internals are built for a
fixed viewport, and given `height: auto` its event list stopped scrolling and
stretched the section to ~7,000px.

---

## 7. Performance and leaks

| Issue | Where | Why it mattered |
|---|---|---|
| 60 identical canvas textures | `Node3D.tsx` | Each node built its own halo texture — byte-identical, and tinted at draw time anyway. Now one shared texture. |
| `edgeActivity` never pruned | `GraphStore.ts` | Counters keyed by edge id grew for the process lifetime. Now deleted with their edge. |
| `MetricStore` never released nodes | `MetricStore.deleteNode()` | History is capped *per node*, but nodes were never removed — every container restarting onto a new id left a full history behind forever. |
| 2D layout recomputed every poll | `App.tsx` | Keyed off node/edge arrays whose identity changes on every telemetry tick. Now keyed on a signature of which services and links exist. |
| Tube geometry leaked per frame | `Edge3D.tsx` | Rebuilt on every position change during layout transitions without disposing the old buffers. |

---

## 8. Testing

`npm test` at the repo root runs `tests/logic.test.ts` (16 tests) covering the
pure logic: all layouts in both views, cycle handling, wrapping, empty and
single-node input, and every heat band including precedence and boundaries.

This is where the Hierarchy infinite loop (3.1) was found. It would not have
shown up in a typecheck, and on screen it looks like a frozen tab rather than
a logic error.

**Note on typechecking the client:** run

```bash
cd client && npx tsc -p tsconfig.app.json --noEmit
```

`npx tsc --noEmit` at the client root **checks nothing** — that directory uses
a solution-style config that only references `tsconfig.app.json`. It exits 0
regardless, which produced several false "clean" results before it was
noticed.

---

## 9. Codebase audit (correctness pass)

A sweep over the whole tree, not just the parts under active change. Each of
these was verified against the code, not assumed.

### 9.1 Command injection in `sanitizeIso` — fixed

`sanitizeIso()` validated with `Date.parse()`, which V8 accepts far more
loosely than ISO-8601. `Date.parse("Jan 1 2026 $(whoami)")` **succeeds**, so
the payload reached the remote shell through
`docker logs --timestamps --since …`.

Not reachable from user input today — `since` is computed server-side — but a
sanitizer whose only job is blocking injection must not depend on every
caller staying trustworthy. Now validated against a strict ISO-8601 regex.
**Where:** `server/telemetry-platform/src/connection/RemoteCommand.ts`.
Regression covered in `tests/security.test.ts`.

The other sanitizers (container id, path, tail) were already allowlist-based
and throw rather than escape, which is the right shape.

### 9.2 `spawn` sites without `error` handlers — fixed

Three places spawned a child process and handled only `close`/`exit`. When
the binary is missing (`python3`, `node`, `ssh` not on PATH), `spawn` emits
`error`; unhandled, that event **throws**, and state was left wrong:

| Where | Consequence |
|---|---|
| `routes.ts` ML process start | process recorded as running when it never started; log fd leaked |
| `TrafficController` traffic-gen start | `genProcess` set to a process that never ran |
| `websocket.ts` SSH terminal | dead session left in the map; next command writes into nothing |

Also in the same area: `runStep()` in the retrain route never settled its
promise if `spawn` failed, leaving the retrain permanently "running" and
blocking every future retrain via the 409 guard.

### 9.3 No process-level crash guards — fixed

An unhandled rejection **terminates the process** in Node 18+. This server
polls hosts that are routinely unreachable, so one stray rejection took every
healthy target down with it. Two floating promises in `GraphStore`
(`discoverAll().then(…)`, `refreshTarget().then(…)`) had no `.catch`.

Both now handled, plus `process.on('unhandledRejection')` and
`process.on('uncaughtException')` that log loudly and keep serving. A crash
loop is strictly worse than a degraded target.
**Where:** `server/index.ts`, `server/graph/GraphStore.ts`.

> Express version matters here: this project is on **Express 5**, which
> forwards async handler rejections to the error handler automatically. Async
> routes without `try/catch` return 500 rather than crashing. That is not
> true on Express 4 — if this is ever downgraded, those routes need wrapping.

### 9.4 Unbounded retrain log — fixed

`retrainState.log` grew for the whole run and was returned **in full** by
`GET /api/ml/retrain`, which the UI polls every 2 seconds. `train.py` prints
a line per trained and per skipped service, so on a 76-service deployment
every poll re-sent the entire accumulated log. Capped at 500 lines; the UI
only renders the tail.

### 9.5 Silently swallowed config errors — fixed

Two `catch {}` blocks hid failures to parse `remote_config.json`, in code
paths that decide **which host to SSH into**. A JSON syntax error silently
fell back to defaults, so the terminal connected somewhere nobody asked for
and discovery looked broken rather than misconfigured. Both now log.

Three other empty catches were confirmed genuinely ignorable (best-effort LAN
IP detection, recursive `mkdir`, unlinking a file that may not exist) and are
now annotated as deliberate rather than looking like oversights.

### 9.6 Checked and found sound

- All other Docker/SSH command sanitizers.
- `MetricStore.events` and `TraceStore.recentEvents` are both capped.
- No `setInterval` in the client without a matching `clearInterval`.
- All five Python files compile; no bare `except:`.
- All division sites are guarded by an early return or a `Math.max(…, 1)`.
- Every traffic-gen JS file parses.

### 9.7 Known, not fixed

- **Two dead duplicate trees**: `telemetry-platform (2)/` and
  `traffic-generator/` (508K combined) have **zero references** from live
  code. They are confusing because they hold the only other test files, which
  look authoritative but test stale copies. They are tracked in git, so
  deleting them is recoverable — left in place pending a decision.
- **No linter** is configured for either `client` or `server`. Everything
  above was found by reading and targeted greps; a linter would catch the
  next one earlier.
- **Log files are tracked in git** (`traffic.log`, `server.log`,
  `ml/logs/*.log`).

---

## 10. Standing rules these changes follow

- **Never fabricate a measurement.** Absent data is absent — no defaulting to
  zero, no deriving an edge metric from a node metric, no inferring a
  dependency from a name.
- **Label things as what they are.** `samplesPerMin`, not
  `connectionsPerMin`. "SSH-sampled", not "distributed tracing". A firing
  rate, not accuracy.
- **Warm colours mean trouble**, and nothing else.
- **Prefer honest empty states.** "Not enough history yet" beats a flat line
  through invented points.

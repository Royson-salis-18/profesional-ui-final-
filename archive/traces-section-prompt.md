Build a separate TRACES section for the Microservice Mapper, plus the
backend collection that feeds it. This is NOT distributed tracing (no
OpenTelemetry/Zipkin spans exist yet — the zipkin container is running but
receiving almost no data). This is honest, from-scratch connection-level
trace collection over SSH, used to build a graph independent of the
existing metrics/logs pipeline.

==================================================
WHAT "TRACES" MEANS HERE
==================================================

Not request-level spans. Not span IDs, not parent/child relationships,
not latency-per-hop. What we actually have available without app
instrumentation is TCP connection events between containers — i.e.
"container A opened a connection to container B, at time T, on port P."

Call this a "connection event," not a "trace," anywhere it's user-facing,
so nobody mistakes it for real distributed tracing later. Internally the
pipeline can still be named trace-collector/trace-graph for continuity
with the rest of the project.

==================================================
COLLECTION METHOD (SSH, no app changes)
==================================================

Per collection cycle, over the existing SSH connection:

1. For each running container (from the existing service inventory),
   capture its active TCP connections:
     docker exec <container> cat /proc/net/tcp /proc/net/tcp6
   or, if that's unavailable inside minimal containers:
     nsenter --target <pid> --net -- ss -tn
   (requires the container's PID on the host — get it via
   `docker inspect -f '{{.State.Pid}}' <container>`)

2. Parse each connection's local/remote IP:port. Resolve IPs to container
   names using the existing network inventory (docker network inspect
   data already collected in Stage 1/2 of the telemetry pipeline).

3. Emit one connection event per resolved (source_container,
   dest_container) pair per cycle:
     { timestamp, source_service, dest_service, dest_port, state }

4. Do NOT deduplicate into "edges exist / don't exist" at collection
   time — keep every event with its timestamp. Aggregation into weighted
   edges happens later, as a separate step, over a chosen time window.

5. Only capture connections between services already in scope (skip
   anything not in the current inventory — no fabricating unknown nodes).

==================================================
WHAT NOT TO DO
==================================================

- Do NOT read application logs to infer request flow here. Log-based
  correlation is a different, separate technique and must not be mixed
  into this graph — this graph is connection-events-only, so its
  accuracy/limitations stay easy to reason about.
- Do NOT fabricate request counts, latency, or span data that wasn't
  actually observed. If latency-per-hop isn't measurable from connection
  events (it mostly isn't), leave it out rather than estimating it.
- Do NOT merge this graph with the existing "Architecture (Declared)" or
  metrics-based "Runtime (Observed)" graphs automatically. It should be
  its own graph mode, selectable separately, so it's clear which graph
  the user is looking at and why the edges look the way they do.
- Do NOT claim this is equivalent to Jaeger/OTel tracing anywhere in the
  UI copy. Label it clearly, e.g. "Observed Connections (SSH-sampled)."

==================================================
GRAPH CONSTRUCTION FROM TRACE EVENTS
==================================================

Separate stage, run over stored connection events for a chosen window:

- Nodes: services that appeared in at least one connection event in the
  window.
- Edges: directed, source_service -> dest_service.
- Edge weight: connection event count in the window (raw count is fine
  as the base weight; normalize for display only, keep raw count in the
  underlying data).
- Store per-edge: event_count, first_seen, last_seen, dest_ports (list —
  useful later for telling apart e.g. DB connections vs HTTP calls).

Output this as its own dataset/graph object, clearly separate from the
metrics-derived feature dataset and from the declared-architecture graph.

==================================================
UI REQUIREMENTS
==================================================

Add a new left-sidebar section, "TRACES," alongside the existing
ARCHITECTURE / TELEMETRY / DEPENDENCIES / ANALYTICS / INCIDENTS /
EXPERIMENTS items — same visual style as those.

Inside it:

1. A live feed panel: most recent connection events, scrolling, with
   timestamp / source / dest / port — similar treatment to the existing
   GLOBAL TERMINAL panel, but structured as a table, not raw log lines.

2. A "Observed Connections" graph view, using the same node/edge
   rendering as the existing Architecture graph, but:
     - edges are directional (arrowheads, source -> dest)
     - edge thickness reflects event_count for the selected window
     - a time-window selector (last 1 min / 5 min / all collected)
   This must be a distinct graph mode from "Architecture (Declared)" and
   "Runtime (Observed)" — add it as a new radio option under GRAPH MODE,
   e.g. "Observed Connections (Traces)."

3. A small status indicator showing whether trace collection is
   currently running for the active project, matching the existing
   HEALTHY/DEGRADED pill style.

==================================================
INTEGRATION CONTRACT
==================================================

Expose this as its own module so it doesn't get entangled with the
existing metrics/logs collector:

  POST /api/traces/start   { targetId }
  POST /api/traces/stop    { targetId }
  GET  /api/traces/events  ?targetId&since=<ts>       (raw events)
  GET  /api/traces/graph   ?targetId&windowSec=<n>     (aggregated graph)

The metrics/logs collector and this trace collector should be able to
run independently — starting/stopping one must not affect the other.

==================================================
OUTPUT
==================================================

Return:
1. Backend: trace collection module (SSH capture + parsing + storage)
2. Backend: graph aggregation module (events -> weighted directed graph)
3. API endpoints as above
4. UI: TRACES sidebar section + live feed + graph view + new graph mode
5. Explicit note in code comments/UI copy that this is SSH-sampled
   connection data, not real distributed tracing, and what its known
   limitations are (samples connections at collection-cycle granularity,
   can miss very short-lived connections between cycles, no per-request
   latency)

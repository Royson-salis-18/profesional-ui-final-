# 18 — Telemetry tiers: the plan

**Status:** in progress. Each phase lists what "done" means so progress is
checkable rather than asserted.

---

## The problem, stated precisely

The README says `edge.metrics` (latency, error rate) is null, that "traces"
are 5-second TCP snapshots rather than per-request spans, and that a proper
Prometheus/Grafana/Tempo stack gives exact histograms we cannot get.

The first two are true and unfixable *within the agentless path*. A socket
table does not contain requests; no amount of work extracts a latency
histogram from `docker stats` and `/proc/net/tcp`. That is physics, not a
missing feature.

The third is where the framing was wrong. **We cannot get that data from the
outside. We can read it when the target already produces it.**

### Measured, 2026-09-18, on the open-telemetry target

Queried through the SSH connection the app already holds:

```
histogram_quantile(0.95, sum(rate(demo_cart_get_cart_latency_seconds_bucket[1h])) by (le))
  -> 0.0829                      # 82.9 ms p95 for cart.get_cart

demo_cart_get_cart_latency_seconds_count
  -> 2296 samples
     service_name="cart"  job="opentelemetry-demo/cart"
     service_version="3.0.0"  service_criticality="high"

query_range over 6h -> 155, 577, 979, 1230, ...   # history well past 1 hour
```

Error-rate series present: `http_server_request_duration_seconds_bucket`,
`http_server_duration_milliseconds_bucket`, `http_server_active_requests`,
`http_server_response_body_size_bytes_bucket`.

Prometheus reports `activeTargets: []` — it is not scraping. The OTel
Collector pushes into it. The data exists because the demo instruments
itself.

### Why this is not simply "use Prometheus"

| Target | Available |
|---|---|
| open-telemetry | Full OTLP: histograms, status codes, service metadata |
| death-star | Jaeger on :16686, **0 services, null spans** — instrumentation off |
| sock-shop | Nothing. No Prometheus, no Jaeger. 909 MB box |
| vertikal | Next.js + Supabase, no APM |

One of four. A design that assumes Prometheus fails on three targets; a
design that ignores it wastes the one target where the ground truth lives.

---

## The design: tiered sources, labelled provenance

| Tier | Source | Gives | Needs |
|---|---|---|---|
| **0** | SSH + cgroups + `/proc/net/tcp` | CPU, memory, network bytes, socket topology | SSH only |
| **1** | Proxy access logs (Envoy, nginx) | Status codes, upstream latency per request | Log config on target |
| **2** | Target's own Prometheus / Jaeger | Exact latency histograms, error rates, spans | Existing instrumentation |

Tier 0 stays the default and the fallback. It is the only tier that works on
an uninstrumented box in thirty seconds, which is the property worth keeping
whatever the project ends up being called.

**Every metric carries where it came from.** Mixing a cgroup estimate with a
histogram quantile and presenting both as "latency" would be exactly the kind
of dishonesty the evidence model (`declared` vs `observed`) exists to
prevent. The same discipline extends to metric provenance.

---

## Why this also fixes the ML

The models are currently crippled by thin data — `sock-shop:front-end` has
**6 distinct values across 1568 rows** (0.4%), because CPU and memory on a
mostly-idle container barely move and the collector samples faster than they
change. Every detector fires on 0% because there is nothing to learn.

Latency and error rate do not behave that way. p95 latency varies
continuously under load; a status-code mix changes the moment anything
degrades. Adding Tier 1/2 features is the most direct fix available for the
distinct-signal problem, and it costs no new instrumentation on the one
target that matters most.

---

## Phases

### Phase 1 — Provenance foundation
Add an explicit source to every metric and edge metric, so any number can say
which tier produced it. Nothing else can land honestly until this exists.

*Done when:* metrics carry a source field end to end, the UI can read it, and
existing Tier 0 numbers are labelled as such. No behaviour change otherwise.

### Phase 2 — Telemetry source abstraction
A `TelemetrySource` interface with the current SSH collector as the first
implementation, so adding a second source is not surgery on `MetricCollector`.
Per-target configuration of which sources to try, in `remote_config.json`.

*Done when:* the existing collector runs unchanged behind the interface, and
a target can declare additional sources without code changes.

### Phase 3 — Prometheus source (Tier 2)
Query the target's Prometheus over the SSH connection already held. Map
PromQL to the fields that are currently null:

- `edge.metrics.latencyP50/P95/P99` from `histogram_quantile` on duration buckets
- `edge.metrics.errorRate` from status-code-labelled counters
- `edge.metrics.requestRate` from `rate()` on the count series

*Done when:* `edge.metrics` is non-null for open-telemetry, values match what
a direct PromQL query returns, and the UI labels them Tier 2.

### Phase 3b — Wiring (done)

Tier 2 metrics reach the graph and the UI.

**Enabling it.** Per target in `server/data/remote_config.json`:

```json
"open-telemetry": {
  "ec2PublicIp": "...",
  "sshKeyPath": "~/Downloads/sock-shop-key.pem",
  "telemetrySources": {
    "prometheus": { "enabled": true, "url": "http://localhost:9090" }
  }
}
```

`localhost` is correct and deliberate — the query runs *on the target* via
curl over the SSH connection already held. Prometheus is bound to localhost
there and only :8080 is open in the security group, so querying from outside
would mean opening a port to read a metric.

Opt-in, never inferred. A reachable Prometheus is not on its own consent to
query it every cycle.

**Failure behaviour.** The whole Tier 2 path is wrapped. If the source is
slow, broken, or returns nonsense, the cycle logs once and returns empty, and
the Tier 0 metrics collected in the same cycle are published unchanged. The
merge is additive for the same reason: a cycle where Prometheus was
unavailable must not wipe the CPU and memory that `docker stats` just
returned. Both properties are covered by tests.

**In the UI.** The inspection sidebar grows a `REQUEST METRICS` block with a
`TIER 2 · prometheus` badge, separate from `LIVE HEALTH` which is now marked
`tier 0 · cgroup`. They are kept apart on purpose: CPU is measured by the
kernel, latency by whatever the target happens to run, and those are not the
same kind of fact.

Two things it will not do:
- A missing quantile reads "not measured", never `0ms`.
- An error rate with no traffic in the window reads "no traffic in window",
  never `0%` — a clean bill of health nobody earned.

*Verified:* server boots with the path wired and stays silent when no target
opts in; 44 tests pass. **Not yet verified against live Prometheus** — all
four targets were unreachable (SSH closed) throughout this work.

### Phase 4 — Edge heat and RCA use real rates
Edge heat currently grades on `samplesPerMin` — socket observations, an
honest proxy but a proxy. Where a real request rate exists, use it. Same for
RCA: real error rates are far stronger evidence than status heuristics.

*Done when:* heat uses request rate where available and socket samples
otherwise, with the difference visible rather than silently swapped.

### Phase 5 — Access logs (Tier 1)
`parseHttpLogLine` and `collectHttpInteractions` already exist and find
nothing, because these proxies do not log to stdout in a parseable form by
default. Document the config change per proxy and make the parser robust to
the formats actually emitted.

*Done when:* a configured Envoy or nginx produces real per-request rows in
Raw Traffic Logs, on a target with no Prometheus.

### Phase 6 — Richer ML features
Extend `ml/` to include latency and error-rate features where the tier
provides them, with the feature set recorded per model so a model trained on
four features is never confused with one trained on seven.

*Done when:* models train on the extended feature set, and distinct-row
counts on instrumented targets are materially better than the current 0.4%.

### Phase 7 — Comparison harness
Use the instrumented target as ground truth and measure how well the
agentless signal tracks it. Does socket-sample rate correlate with real
request rate? Does a cgroup-only Isolation Forest detect what a
latency-aware one detects?

*Done when:* there is a reproducible comparison with numbers. This is the
part most likely to be publishable, and it only exists because Tier 0 was
kept rather than replaced.

---

## Sequencing note

Phases 1–2 are pure refactoring and can be done with every target offline —
which matters, because all four were unreachable when this plan was written
(the EC2 IPs rotate constantly). Phases 3 onward need a live instrumented
target for verification.

# ecom-lab -- a third-party project as a test subject

[`tahaberkamcadev/ecom`](https://github.com/tahaberkamcadev/ecom) (Spring Boot 4, Kafka + Debezium transactional outbox, saga with compensation, CQRS read model, Prometheus/Grafana/Loki)
used **unmodified**, pinned to commit `2de1ef8`. This directory adds only what is needed to run it small, load it, break it in known ways and
say what the mapper should see:

```
fetch.sh            clones upstream at the pinned commit into ./upstream (git-ignored; never edited)
stack.sh            runs it with the overlays below:  ./stack.sh up | down | ps | logs <svc>
overlays/
  no-es.yml           run without Elasticsearch (upstream supports it: APP_ELASTICSEARCH_ENABLED)
  small.yml           ~2.7 GB profile: tuned JVMs + container limits; Kafka UI/Grafana/Loki/Promtail moved to profile "extras"
  histograms.yml      request-duration histogram buckets (for the mapper's Tier 2) -- for PROFILE=full; small.yml already includes it
  loadtest.yml        turns the gateway rate limiter off so a single load generator is not answered with 429
sandbox-ca/         ONLY for builds behind a TLS-intercepting proxy: patched Dockerfile copies + override (upstream untouched)
loadgen/            load generator + journeys (browse 65 / orders 10 / purchase 25; setup registers users and creates a bulk-stock product)
probe.sh            one-shot health snapshot: containers, CPU/mem, API status codes, saga state, Kafka lag
run-scenario.sh     apply a scenario to a fresh stack, drive load, inject the fault mid-run, record before/during
scenarios/ec-*/     compose.override.yml and/or inject.sh + restore.sh, and scenario.yaml (ground truth + what the mapper should see)
results/            raw output of the runs recorded in each scenario.yaml
```

## Running it

```bash
./stack.sh up                      # small profile; first build compiles 7 Spring Boot services with Maven (several minutes)
LOADTEST=1 ./stack.sh up           # same, rate limiter off (needed for any load generator on one IP)
PROFILE=full ./stack.sh up         # everything upstream ships except Elasticsearch (add ES=1 if your network can pull it)
node loadgen/loadgen.mjs --concurrency 40 --duration 60
./probe.sh
./run-scenario.sh ec-04-inventory-db-down
./stack.sh down
```

Behind a TLS-intercepting proxy: `BUILD_CA_DIR=/dir/with/ca-bundle.crt ./stack.sh up` (the sandbox this was developed in also blocks Alpine's and
Elastic's registries, which is why that path replaces `apk add curl` with a `wget` healthcheck and why Elasticsearch could not run there).

## Sizing (measured, Docker 29, cgroup v1, 4 cores / 16 GB host)

| Profile | Containers | Memory in use | Time to healthy (cold, fresh volumes) | Notes |
|---|---|---|---|---|
| upstream full, no Elasticsearch | 22 | ~4.6 GB idle, ~5.2 GB host | ~2.5 min | no limits; every JVM sized at 75% of host RAM |
| **small** | 18 | **~2.7 GB idle, ~2.95 GB under 300 req/s** | 79 s | 0 errors, no OOM kills at 40 and 500 concurrent clients |

* A first attempt at the small profile (384 MB for projection-service) was **OOM-killed at startup**; the shipped limits come from that measurement.
* Small-profile JVMs use SerialGC and C1-only JIT. That lowers peak CPU efficiency; state it when quoting any throughput number.
* **A 4 GiB instance is marginal:** ~2.95 GB of containers plus the OS, Docker and (if co-located) the mapper's agent leaves little headroom; add swap, or
  use 8 GiB for the small profile and 16 GiB for `PROFILE=full`. I could not test on an actual small instance. 2 vCPUs will also lengthen cold start.
* Dropping the review stack saves another ~0.4 GB but needs `connect-init`'s connector list edited (it registers a review connector); not done here.

## What the mapper can and cannot see on this system (checked against the mapper's own code)

| Mapper input | Result on ecom | Why / fix |
|---|---|---|
| Declared edges (compose `depends_on`) | works (render one merged file, see ../docs/HOW-IT-FITS-THE-MAPPER.md) | |
| Observed edges (/proc/net/tcp) | works: Postgres, Redis, Kafka and HTTP are real TCP between containers | |
| Tier 0 (docker stats, container state) | works | |
| **Tier 1 (gateway access log)** | **blind**: the Spring Cloud Gateway writes no per-request log lines and nothing in the nginx JSON shape | would need an access-log config or an nginx edge in front |
| **Tier 2 (Prometheus)** | **reports "unavailable" as shipped.** Ran the mapper's real `PrometheusSource` against this stack: *"none is a known request-duration histogram"* | three reasons, all small: (1) Micrometer emits `http_server_requests_seconds` (not in the mapper's family list); (2) service identity is the `application` label under one `spring-boot` job (not in its label list); (3) the status label is `status` (not in its list). Buckets also need enabling (`small.yml`/`histograms.yml` do). With those three entries added to a scratch copy of the mapper's source, it returned p95 **and** error rate for all 7 services. |

## Honest limits

* Upstream is a portfolio project; its mock payment provider, 10% decline rate and fixed 2 s delay are simulation, not a real PSP.
* The author's "485/485 concurrent purchases" figure measures only the HTTP accept path (one ~1.8 s burst). The saga itself drains at ~1.5 payments/s with default settings
  (3 consumer threads x 2 s mock delay): after 75 s at ~300 req/s the stack held ~3,000 pending payments, so **any sustained purchase load builds a saga backlog by design** -- scenario `ec-01` is built on that.
* Elasticsearch was never run here (registry blocked); full-text search is untested. Everything else listed above was run.

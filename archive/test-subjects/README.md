# Microservice Test Subjects

Two production-style microservice systems, built as **test subjects for [Microservice Mapper](https://github.com/Royson-salis-18/microservice-mapper)** and its RCA lab.

> The code in both systems is correct, defensive and reviewable: timeouts, bounded retries, idempotency, health/readiness
> probes, graceful shutdown, pooled connections, structured logs. **Every failure in this repo comes from somewhere else** --
> configuration drift, data volume, capacity sizing, deployment topology, third-party behaviour, or the *interaction* of
> two individually-correct components. That is how most real production incidents look, and it is exactly the class of problem
> an outside-in mapper (declared vs observed topology, container telemetry, gateway logs) is built to shorten.

| Subject | Domain | Containers | Shape | Scenarios |
|---|---|---|---|---|
| [**ShopFlow**](shopflow/README.md) | Online retail / checkout | 13 + traffic + 5 monitoring | sync HTTP fan-out, cache-aside, Postgres x2, Redis x2, NATS JetStream consumer | 12 (`sf-00` ... `sf-11`) |
| [**LedgerLine**](ledgerline/README.md) | Retail-banking transfers | 12 + traffic + 5 monitoring | saga orchestrator, double-entry ledger, third-party FX + breaker, batch worker, possible dependency cycle | 7 (`ll-00` ... `ll-06`) |

Each subject has a **healthy baseline** (the control group) and one scenario per production condition. Every scenario ships with
a machine-readable **ground truth** (`scenario.yaml`): the true root cause, the symptomatic services, which signals the mapper can
see (strong / partial / blind), and which graph edges must be declared and/or observed.

## Run it on an EC2 instance (one command)

```bash
# on a fresh Ubuntu / Amazon Linux instance (>= 2 GiB RAM recommended; the whole ShopFlow bench is ~0.6 GiB of containers):
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/<branch>/test-subjects/bootstrap/ec2-setup.sh | bash -s -- shopflow     # or: ledgerline
```

It installs Docker, clones the repo, and runs `make bench`: the application, an always-on traffic generator, and **Prometheus + Grafana + Loki + Promtail +
docker-exporter** with a provisioned dashboard. Only the gateway port is public; Grafana/Prometheus listen on localhost -- view them through
`ssh -L 3000:localhost:3000 -L 9090:localhost:9090 ubuntu@<ip>`. Then add the instance to the mapper (Target ID `shopflow`, the IP, SSH user, key) and apply faults with
`sudo make -C <project> scenario SCEN=sf-05-secret-rotation` (each change is stamped on the Grafana timeline). `bootstrap/ec2-setup.sh` has not been run on a real EC2 instance yet;
its pieces (bench, monitoring, dashboards) were each run and verified in Docker. If the repo is private, clone it first instead of using `curl | bash`.

## Try a failure on the instance (one command)

```bash
cd ~/bench/test-subjects && lab/bench-scenario.sh shopflow sf-05-secret-rotation 60      # or any scenario id: make -C shopflow scenarios
```

Applies the scenario, drives the load that triggers it, prints container states and API status codes next to the scenario's expected result, saves the report to
`~/bench-results/`, then resets to the baseline (`KEEP=1` leaves it applied). Verified here against real containers (sf-05: orders restarted 8 times, `/api/orders` and `/api/checkout`
returned 502 while the catalog stayed 200).

## Quick start (each project is self-contained)

```bash
cd shopflow            # or: cd ledgerline
make bench             # app + always-on traffic + Prometheus/Grafana/Loki, then see `make urls`
make test              # builds the images, starts every container, runs the API tests (14 tests, every service), leaves it running
make load              # 60 s of realistic traffic against the gateway
make scenario SCEN=sf-05-secret-rotation   # inject one production condition (make scenarios lists them)
make down              # stop and delete volumes (databases re-seed on next start)
```

Everything a project needs lives in its own directory: `docker-compose.yml`, one `Dockerfile` per service, the service library
(`lib/`), database seeds, nginx config, load generator, API tests, scenarios and a `Makefile`. Behind a TLS-intercepting proxy add
`BUILD_CA_BUNDLE=/path/ca.crt` to any `make` command.

From the repo root: `npm run install:all && npm test` (syntax + static validation of all 29 scenarios, needs the docker CLI but no
daemon) and `npm run test:api` (both projects in real containers). No Docker at all? `lab/local-stack.sh shopflow up` runs the same
services as plain processes.

## A third subject: ecom-lab (a real open-source project)

[`ecom-lab/`](ecom-lab/README.md) runs [`tahaberkamcadev/ecom`](https://github.com/tahaberkamcadev/ecom) -- Spring Boot, Kafka + Debezium outbox, saga with compensation, CQRS read model --
**unmodified** at a pinned commit, with overlays to run it in ~2.7 GB (`stack.sh`), a load generator, a health probe, and **10 scenarios with ground truth**
(`ec-00` ... `ec-09`), each run in Docker with the measurements recorded. Its README documents what the mapper can and cannot see there:
Tier 1 is blind, and Tier 2 reports "unavailable" until three small additions are made to the mapper (checked by running the mapper's own `PrometheusSource`).
Start with [`ecom-lab/README.md`](ecom-lab/README.md) and [`ecom-lab/EC2.md`](ecom-lab/EC2.md).

## What is in the box

```
shopflow/                 self-contained project
  docker-compose.yml        healthy baseline (12 containers)       docker-compose.expose.yml   publishes every service on 127.0.0.1 for tests
  services/<name>/          index.js + Dockerfile (one per service)
  lib/                      service plumbing: HTTP server/client, pools, metrics, queue consumer, lifecycle
  db/  nginx/  observability/   seeds, gateway config; docker-compose.obs.yml + observability/ = Prometheus, Grafana (provisioned dashboard), Loki, Promtail, docker-exporter
  loadgen/                  traffic generator + journeys          tests/   API tests (node:test)
  scenarios/sf-*/           compose.override.yml + scenario.yaml (ground truth) [+ local.env]
  Makefile
ledgerline/               same layout
ecom-lab/                 third-party project pinned at a commit + overlays, scenarios, load generator (see above)
lab/                      cross-project tools: up.sh/down.sh (render one compose file), validate.mjs, check-scenario.mjs, local-stack.sh
docs/                     HOW-IT-FITS-THE-MAPPER.md, SCENARIO-CATALOG.md
```

The two projects intentionally share no code at runtime: each carries its own copy of `lib/`, as two independent teams' services would.

Read next: [docs/HOW-IT-FITS-THE-MAPPER.md](docs/HOW-IT-FITS-THE-MAPPER.md) (why these systems and these failures; how to attach them to
the mapper; what the mapper cannot see) and [docs/SCENARIO-CATALOG.md](docs/SCENARIO-CATALOG.md).

## Honest status

Verified by running it (real Docker containers: nginx, Postgres 16, Redis 7, NATS 2.10 and the services):

* **API tests: 14/14 pass for each project from a clean `make test`** -- every endpoint of every service, validation and error paths,
  idempotency, the full checkout and transfer sagas, double-entry conservation under concurrency, the async event path, the gateway
  routing table, and the access-log shape the mapper parses.
* **Observability (verified):** `make bench` starts app + traffic + monitoring; `lab/verify-observability.mjs` runs every dashboard panel's query: ShopFlow 31/31 and LedgerLine 31/31 checks pass (targets up, datasources healthy, dashboard provisioned, every panel returns data). Whole ShopFlow bench = ~610 MiB of containers (373 app+traffic, 236 monitoring).
* **Baselines under load:** ShopFlow ~520 req/s with 0 errors; LedgerLine correct books (entries sum to 0, money conserved).
* **Scenarios reproduced in Docker with measurements recorded in their `scenario.yaml`:** `sf-03` (memory ramp to 95% then restart),
  `sf-05` (real scram auth failure, restart loop, healthy DB), `sf-09` (flat ~26% CPU at 0.25 cpus), `ll-05` (batch restart loop on 2M rows).
* **Scenarios reproduced as plain processes** (same code, real Postgres/Redis/NATS, no cgroups): `sf-01`, `sf-02`, `sf-04`, `sf-06`, `sf-08`,
  `sf-10`, `sf-11`, `ll-01`, `ll-02`, `ll-03`, `ll-04` (exhaustion), `ll-06`. Numbers are in `measured_locally`.
* **Not yet executed in Docker:** `sf-01`, `sf-02`, `sf-04`, `sf-06`, `sf-07`, `sf-08`, `sf-10`, `sf-11`, `ll-01`..`ll-04`, `ll-06`; and `ll-04`'s
  failover flip was never reproduced anywhere. Their compose files render and are statically validated; `make scenario SCEN=...` runs them.
* **Not run against the mapper itself.** `scenario.yaml` is the specification to run it against (`lab/check-scenario.mjs`).

Bugs the real runs caught in this repo (fixed): the ledger debited payers the amount but not the fee, so balances drifted from entries;
the ledger seed could abort Postgres init and leave a half-initialised database; an access-log test mishandled nginx's empty `upstream_addr`.

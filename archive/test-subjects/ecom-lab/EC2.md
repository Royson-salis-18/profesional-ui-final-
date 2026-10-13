# Running ecom-lab on a small EC2 instance

**Not tested on EC2.** Everything below was measured in Docker on a 4-core / 16 GB host; the numbers say what to expect, not what an instance delivers.

## Pick the instance from the measurements

| Profile | Steady memory (measured) | Under ~300 req/s | Suggested instance RAM |
|---|---|---|---|
| `small` (default, 18 containers) | ~2.7 GB | ~2.95 GB, peak sample 2.97 GB | **8 GiB comfortable; 4 GiB marginal** (OS + Docker + a co-located collector leave ~0.5 GB) |
| `PROFILE=full` (22 containers, no Elasticsearch) | ~4.6 GB | not measured | 8 GiB minimum |

On 4 GiB: add swap (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`), expect Kafka and Debezium to be the first things
squeezed, and do not run the load generator on the same box. With 2 vCPUs expect a slower cold start than the measured 79 s, and a first image build of
7 Maven projects that takes many minutes (build the images elsewhere and `docker save | ssh ... docker load` if that is a problem).
Please verify the actual memory of your instance type before choosing; I did not look it up.

## Steps

```bash
# Docker Engine + compose plugin installed, git, node >= 20 (for the load generator / probe)
git clone <this repo> && cd <repo>/test-subjects/ecom-lab
EC2=1 LOADTEST=1 FAST_PSP=1 ./stack.sh up        # small profile; only :8080 public, Prometheus on 127.0.0.1:9090
./probe.sh                                       # container state, resources, API outcomes, saga state
node loadgen/loadgen.mjs --base http://localhost:8080 --concurrency 20 --duration 120
```

* **Security group:** allow inbound **22** and **8080** only. Upstream publishes every database, Kafka and Redis port with demo-default passwords;
  `EC2=1` removes those publishes, but Docker-published ports bypass `ufw`, so the security group is the real control.
* `LOADTEST=1` turns the gateway rate limiter off. Leave it off for any single-source load generator; leave it ON to reproduce `ec-09`.
* `FAST_PSP=1` uses a 200 ms payment provider so a healthy saga drains realistic traffic; omit it to get upstream's 2 s demo delay (saga backlog by design).

## Pointing the mapper at it

* Add the project (Target ID e.g. `ecom`, the instance IP, SSH user/key). The mapper reads declared dependencies from the compose file named in the
  container label `com.docker.compose.project.config_files`; `stack.sh` runs one merged set of `-f` files, which Docker comma-joins in that label, and the mapper
  does not split it -- see the finding in `../docs/HOW-IT-FITS-THE-MAPPER.md`. To get declared edges today, render one file first:
  `cd upstream && docker compose <the -f list from ./stack.sh files> config > /home/ubuntu/ecom.rendered.yml` and start from that single file.
* Tier 1 (gateway log) is blind on this system and Tier 2 reports "unavailable" until the mapper learns Micrometer's names -- details and the exact three additions in `README.md`.
  Tier 0 (container stats/state) and observed edges work as they are.
* Run a scenario: `./run-scenario.sh ec-04-inventory-db-down`, then compare the mapper's view with `scenarios/ec-04-inventory-db-down/scenario.yaml`.

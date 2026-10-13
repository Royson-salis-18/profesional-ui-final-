#!/usr/bin/env bash
# Run the upstream ecom project with overlays from this directory (upstream is cloned at a pinned commit; its files are never edited).
#   ./stack.sh up            small profile (default, ~2.7 GB):  no Elasticsearch / Kafka UI / Grafana / Loki / Promtail, tuned JVMs
#   PROFILE=full ./stack.sh up    everything upstream ships, minus Elasticsearch unless ES=1 (~4.6 GB without ES)
#   ./stack.sh down | ps | logs <svc> | files        (files prints the effective -f list)
# Options (env):  SCENARIO=<id> apply ./scenarios/<id>/compose.override.yml      LOADTEST=1 disable the gateway rate limiter
#                 EC2=1 publish only the gateway (8080) + Prometheus on 127.0.0.1
#                 FAST_PSP=1 use a 200 ms payment provider instead of upstream's 2 s demo delay (healthy saga capacity)
#                 BUILD_CA_DIR=/dir  build behind a TLS-intercepting proxy (see sandbox-ca/gen.sh)      HISTOGRAMS=0 skip duration histograms
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; "$HERE/fetch.sh" >/dev/null
cd "$HERE/upstream"
PROFILE="${PROFILE:-small}"
F=(-f compose.yaml)
[ "${ES:-0}" = 1 ] || F+=(-f "$HERE/overlays/no-es.yml")
if [ -n "${BUILD_CA_DIR:-}" ]; then CA_DIR="$BUILD_CA_DIR" "$HERE/sandbox-ca/gen.sh" >/dev/null; F+=(-f "$HERE/sandbox-ca/out/compose.ca.yml"); fi
[ "${HISTOGRAMS:-1}" = 1 ] && [ "$PROFILE" = full ] && F+=(-f "$HERE/overlays/histograms.yml")
[ "$PROFILE" = small ] && F+=(-f "$HERE/overlays/small.yml")
[ "${EC2:-0}" = 1 ] && F+=(-f "$HERE/overlays/ec2-ports.yml")
[ "${LOADTEST:-0}" = 1 ] && F+=(-f "$HERE/overlays/loadtest.yml")
[ "${FAST_PSP:-0}" = 1 ] && F+=(-f "$HERE/overlays/fast-psp.yml")
[ -n "${SCENARIO:-}" ] && F+=(-f "$HERE/scenarios/$SCENARIO/compose.override.yml")
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
case "${1:-up}" in
  up)    docker compose "${F[@]}" up -d ${NO_BUILD:+--no-build} ;;
  down)  COMPOSE_PROFILES=extras,es docker compose "${F[@]}" down -v --remove-orphans ;;
  ps)    docker compose "${F[@]}" ps ;;
  logs)  docker compose "${F[@]}" logs --tail 80 "${2:-}" ;;
  files) echo "${F[@]}" ;;
  *) echo "usage: $0 up|down|ps|logs|files" >&2; exit 2 ;;
esac

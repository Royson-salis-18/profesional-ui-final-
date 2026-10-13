#!/usr/bin/env bash
# Apply one scenario to a FRESH stack, drive load, inject any runtime fault mid-run, and record what the system does.
#   ./run-scenario.sh ec-04-inventory-db-down [load_seconds=60] [concurrency=20]
# Output: results/<id>.txt  (probe before the fault, probe during it, load-generator summary).  Restores the fault at the end.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
ID="${1:?scenario id}"; DUR="${2:-60}"; CONC="${3:-20}"
MIX="${MIX:-browse=75,orders=15,purchase=10}"; [ "$ID" = ec-08-heap-too-small ] && MIX="browse=20,purchase=80"   # this fault only bites on purchase bursts
SD="scenarios/$ID"; [ -d "$SD" ] || { echo "no such scenario" >&2; exit 2; }
mkdir -p results; OUT="results/$ID.txt"; : > "$OUT"
say() { echo -e "$*" | tee -a "$OUT"; }
export NO_BUILD=1 FAST_PSP=1          # healthy baseline saga capacity; ec-01 overrides the provider delay itself
LT=1; [ "$ID" = ec-09-shared-egress-ip ] && LT=0           # this scenario is about the rate limiter staying ON
SCENARIO="$ID" LOADTEST=$LT ./stack.sh down >/dev/null 2>&1
SCENARIO="$ID" LOADTEST=$LT ./stack.sh up >/dev/null 2>&1
for i in $(seq 1 80); do curl -sf 'localhost:8080/api/catalog/products?size=1' >/dev/null 2>&1 && [ "$(docker ps --filter health=healthy -q | wc -l)" -ge 16 ] && break; sleep 5; done
for i in $(seq 1 60); do N=$(curl -s -m 5 "localhost:8080/api/catalog/products?size=1" | python3 -c "import sys,json;print(json.load(sys.stdin)['total'])" 2>/dev/null || echo 0); [ "${N:-0}" -ge 10 ] && break; sleep 3; done   # catalog seeded through the outbox pipeline
sleep 5
say "### $ID  (load ${DUR}s, concurrency ${CONC})"
node loadgen/loadgen.mjs --concurrency "$CONC" --duration "$DUR" --users 40 --think-ms 250 --mix "$MIX" >"results/$ID.load.json" 2>"results/$ID.load.err" &
LG=$!
while [ ! -s "results/$ID.load.err" ]; do sleep 1; done            # first measured tick == setup finished
if [ -x "$SD/inject.sh" ]; then
  sleep 8; say "\n--- BEFORE fault ---"; ./probe.sh 2>&1 | tee -a "$OUT" | sed -n '/== API/,$p' >/dev/null
  say "\n>>> injecting: $(grep -v '^#!' "$SD/inject.sh" | tr '\n' ' ')"; "$SD/inject.sh" >/dev/null 2>&1; INJ=$(date +%s)
  sleep 20; say "\n--- orders by status, 20 s later ---"; docker exec upstream-postgres-order-1 psql -U order -d orderdb -tAc "select status||'='||count(*) from orders group by status order by status" 2>&1 | tr '\n' ' ' | tee -a "$OUT"; echo | tee -a "$OUT" >/dev/null
  sleep 12
else
  sleep 30
fi
say "\n--- DURING (fault active) ---"; ./probe.sh 2>&1 | tee -a "$OUT" >/dev/null
wait $LG
say "\n--- load generator (whole run) ---"; python3 - "results/$ID.load.json" <<'PY' | tee -a "$OUT"
import json,sys
d=json.load(open(sys.argv[1])); print(d['overall'],'| rps',d['rps'],'| status',d['status'])
for v in d['routes'].values(): print('  ',v)
PY
say "\nload ticks (5s windows):"; grep -E "^[0-9]{2}:" "results/$ID.load.err" | tee -a "$OUT" | tail -14 >/dev/null
[ -x "$SD/restore.sh" ] && "$SD/restore.sh" >/dev/null 2>&1
say "\ndone"

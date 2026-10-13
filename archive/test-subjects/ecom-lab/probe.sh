#!/usr/bin/env bash
# One-shot health snapshot of the ecom stack: container state, resources, API outcomes, saga state, Kafka consumer lag.
#   ./probe.sh            (needs docker; uses the gateway on localhost:8080)
G="${GATEWAY_URL:-http://localhost:8080}"
echo "== containers (state, restarts, oom) =="
docker ps -a --format '{{.Names}}' | grep '^upstream-' | sort | while read n; do
  docker inspect "$n" --format '{{printf "%-30s" .Name}} {{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' | sed 's#/upstream-##'
done
echo "== cpu / memory =="
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemPerc}}' 2>/dev/null | sed 's/upstream-//; s/-1 / /' | sort | tr '\n' ';'; echo
echo "== API outcomes (status codes) =="
code() { curl -s -o /dev/null -m 6 -w '%{http_code}' "$@" 2>/dev/null; }
TOKEN=$(curl -s -m 6 -X POST $G/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"admin@demo.local","password":"DemoAdmin1!"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
PID=$(curl -s -m 6 "$G/api/catalog/products?size=1" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['productId'])" 2>/dev/null)
echo "login=$([ -n "$TOKEN" ] && echo 200 || echo FAIL) catalog_list=$(code "$G/api/catalog/products?size=2") product_detail=$(code "$G/api/catalog/products/$PID") my_orders=$(code "$G/api/catalog/orders" -H "Authorization: Bearer $TOKEN") purchase=$(code -X POST $G/api/products/purchase -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"items\":[{\"productId\":\"$PID\",\"quantity\":1}]}") reviews=$(code "$G/api/catalog/products/$PID/reviews")"
echo "== saga =="
docker exec upstream-postgres-order-1 psql -U order -d orderdb -tAc "select status||'='||count(*) from orders group by status order by status" 2>/dev/null | tr '\n' ' '; echo
echo "kafka consumer lag: $(docker exec upstream-kafka-1 kafka-consumer-groups --bootstrap-server localhost:9093 --describe --all-groups 2>/dev/null | awk '$6 ~ /^[0-9]+$/ {s+=$6} END{print s+0}') messages"

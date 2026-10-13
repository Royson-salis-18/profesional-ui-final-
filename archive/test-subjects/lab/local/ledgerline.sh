# sourced by local-stack.sh -- brings up LedgerLine on localhost
INFRA="$(scen_env infra)"; if [ -n "${INFRA// /}" ]; then export $INFRA; fi
PG_MAX_CONNECTIONS="${PG_MAX_CONNECTIONS:-100}"
start_pg accounts 5451; start_pg ledger 5452
seed 5451 accounts "$ROOT/ledgerline/db/accounts-db/10-init.sh" SEED_ACCOUNTS="${SEED_ACCOUNTS:-20000}"
seed 5452 ledger   "$ROOT/ledgerline/db/ledger-db/10-init.sh"   SEED_ACCOUNTS="${SEED_ACCOUNTS:-20000}" SEED_FEE_ENTRIES="${SEED_FEE_ENTRIES:-2000}"
redis-server --port 6451 --maxmemory 96mb --maxmemory-policy volatile-lru --save "" --dir "$RUN" --daemonize yes --pidfile "$RUN/redis-state.pid" --logfile "$RUN/redis-state.log" >/dev/null
spawn event-bus -- "$NATS" -js -sd "$RUN/nats" -p 4251
sleep 1
B=ledgerline/services; N="node"; NATS_URL=nats://127.0.0.1:4251
spawn fx-provider PORT=4100 $(scen_env fx-provider) -- $N $B/fx-provider/index.js
spawn fx-rates PORT=3105 FX_PROVIDER_URL=http://127.0.0.1:4100 $(scen_env fx-rates) -- $N $B/fx-rates/index.js
spawn accounts PORT=3101 ACCOUNTS_DB_HOST=127.0.0.1 ACCOUNTS_DB_PORT=5451 FRAUD_URL=http://127.0.0.1:3104 $(scen_env accounts) -- $N $B/accounts/index.js
spawn fraud-screening PORT=3104 STATE_STORE_HOST=127.0.0.1 STATE_STORE_PORT=6451 ACCOUNTS_URL=http://127.0.0.1:3101 FX_URL=http://127.0.0.1:3105 $(scen_env fraud-screening) -- $N $B/fraud-screening/index.js
spawn ledger PORT=3103 LEDGER_DB_HOST=127.0.0.1 LEDGER_DB_PORT=5452 $(scen_env ledger) -- $N $B/ledger/index.js
spawn transfers PORT=3102 STATE_STORE_HOST=127.0.0.1 STATE_STORE_PORT=6451 NATS_URL=$NATS_URL ACCOUNTS_URL=http://127.0.0.1:3101 FRAUD_URL=http://127.0.0.1:3104 FX_URL=http://127.0.0.1:3105 LEDGER_URL=http://127.0.0.1:3103 $(scen_env transfers) -- $N $B/transfers/index.js
spawn statements-worker PORT=3106 STATEMENTS_DB_HOST=127.0.0.1 STATEMENTS_DB_PORT=5452 STATEMENTS_DB_USER=reporting STATEMENTS_DB_PASSWORD=reporting-secret NATS_URL=$NATS_URL ACCOUNTS_URL=http://127.0.0.1:3101 STATEMENT_BATCH_INTERVAL_S=${STATEMENT_BATCH_INTERVAL_S:-20} STATEMENT_FIRST_RUN_DELAY_S=5 $(scen_env statements-worker) -- $N $B/statements-worker/index.js
ROUTES='[{"prefix":"/api/accounts/","rewrite":["^/api/accounts/","/accounts/"],"upstream":"http://127.0.0.1:3101"},{"prefix":"/api/transfers","rewrite":["^/api/transfers","/transfers"],"upstream":"http://127.0.0.1:3102"},{"prefix":"/api/statements/","rewrite":["^/api/statements/","/statements/"],"upstream":"http://127.0.0.1:3106"}]'
spawn edge PORT=8081 ROUTES="$ROUTES" ACCESS_LOG="$RUN/edge-access.log" -- node lab/local/gateway-shim.js
for i in $(seq 1 60); do curl -sf localhost:8081/api/accounts/acct-00001 >/dev/null && break; sleep 0.5; done
echo "ledgerline up on :8081 (logs in $RUN)"

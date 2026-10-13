# LedgerLine -- retail-banking transfers

Move money between accounts with fraud screening, FX conversion, an append-only double-entry ledger and statement generation.

```
                         internet
                            | :8081
                      +-----------+          JSON access log
                      |   edge    |          nginx
                      +-+---+---+-+
        /api/accounts   |   |   |   /api/statements
          +-------------+   |   +-----------------+
          v                 | /api/transfers      v
    +----------+            v               +-------------------+
    | accounts |---risk---+ +-----------+   | statements-worker |-- reads --> ledger-db
    +----+-----+  badge   | | transfers |   +---------+---------+             (reporting role)
         |                v +-+--+--+--++             ^ transfer.completed
         v        +-----------------+ | |  |          |
    accounts-db   | fraud-screening |<+ |  |   +-------------+
    (postgres)    +--------+--------+   |  +-->|  event-bus  |  NATS
                           |            |      +-------------+
                           v            +-----> ledger ---> ledger-db (postgres, double-entry)
                      state-store       |
                  (redis: velocity,     +-----> fx-rates ---> fx-provider (third party)
                   idempotency keys)           (cache + breaker)
```


(The baseline is a clean DAG: `accounts -> fraud-screening` exists for the profile page's risk badge; `fraud-screening` has no call
back into `accounts` until a scenario turns the "account age" rule on.)

| Service | Role | Notable settings (env) |
|---|---|---|
| edge | nginx, JSON access log, forwards `Idempotency-Key` | `EDGE_READ_TIMEOUT` |
| accounts | account + profile reads; the profile holds a `FOR SHARE` snapshot while it asks fraud for a risk badge | `ACCOUNTS_DB_POOL_MAX`, `FRAUD_TIMEOUT_MS` |
| transfers | orchestrator: accounts -> fraud -> (fx) -> ledger -> publish; idempotent via the state-store | per-hop timeouts, `LEDGER_RETRY_*` |
| fraud-screening | amount + velocity rules; optional rules: account age (`FRAUD_ENRICH_FROM_ACCOUNTS`), USD normalisation (`FRAUD_NORMALISE_AMOUNTS`) | |
| fx-rates | rates API with a 5 s cache and a circuit breaker | `FX_BREAKER_FAILURES/OPEN_MS`, `FX_STALE_IF_ERROR_MS` |
| fx-provider | simulated third-party rate vendor | `FX_PROVIDER_MODE` = ok / down / slow |
| ledger | atomic double-entry posting, consistent lock order (no deadlocks), fee posting `deferred` (insert-only) or `inline` | `LEDGER_DB_POOL_MAX`, `FEE_POSTING`, `FEE_BPS` |
| ledger-db | Postgres 16: balances + insert-only entries; read-only `reporting` role | `max_connections`, `SEED_FEE_ENTRIES` |
| statements-worker | per-account statements over touched accounts (periodic) + on-demand API; treasury account every run | `STATEMENTS_DB_POOL_MAX`, `STATEMENT_CONCURRENCY`, `STATEMENT_BATCH_INTERVAL_S` |
| state-store | Redis (idempotency keys, velocity counters) | `volatile-lru` |
| event-bus | NATS JetStream `TRANSFERS` | |

## Correctness (verified)

Enforced by the API tests on every run: each transfer posts three entries that sum to zero (payer -(amount+fee), payee +amount, treasury +fee);
the payer's balance moves by exactly amount+fee; 60 concurrent transfers conserve the total across all touched accounts; a replayed
`Idempotency-Key` or ledger `txnId` never posts twice. (An earlier version debited the payer without the fee; the tests caught it.)

## Traffic

`node lab/loadgen.mjs ledgerline` (transfer 55 / fx-transfer 10 / profile 25 / statement 10). Public paths:

```
POST /api/transfers   (header Idempotency-Key: <uuid>)   {"from":"acct-00010","to":"acct-02500","amountCents":1500,"currency":"USD"}
GET  /api/accounts/{id}/risk-profile                      GET /api/statements/{id}
```
Seeded ids: `acct-00001` ... `acct-20000` (currency by id: USD x3, EUR, GBP) and the treasury `acct-fees`.

## Run and test it

```bash
make test            # build, start all containers, run the API tests (tests/api.test.mjs)
make load            # traffic through the gateway
make ps | make logs SVC=<service>
make scenario SCEN=<id>      # ll-00-baseline is the control group; `make scenarios` lists the rest
make down
lab/local-stack.sh ledgerline up    # no Docker: plain processes (needs node, postgres, redis, nats-server)
```

`docker-compose.expose.yml` (used by `make`) publishes every service on 127.0.0.1 so each API can be called directly; the baseline file
itself exposes only the gateway. The API tests (`tests/api.test.mjs`) are the executable description of every endpoint.

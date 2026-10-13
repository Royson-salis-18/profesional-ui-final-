# Scenario catalogue

Generated from each `scenario.yaml`. Open the spec for the full story: why review/tests pass, the production condition, load command, mapper signals, blind spots and the fix.

| ID | What happens | Class | Verified | True root cause |
|---|---|---|---|---|
| [`ec-00-baseline`](../ecom-lab/scenarios/ec-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | docker | — |
| [`ec-01-slow-psp`](../ecom-lab/scenarios/ec-01-slow-psp/scenario.yaml) | The payment provider slows down and orders silently pile up | asynchronous capacity / silent degradation | docker | payment-service |
| [`ec-02-debezium-down`](../ecom-lab/scenarios/ec-02-debezium-down/scenario.yaml) | The change-data-capture connector stops and the order pipeline freezes | infrastructure failure / silent data stall | docker | connect |
| [`ec-03-kafka-down`](../ecom-lab/scenarios/ec-03-kafka-down/scenario.yaml) | Kafka goes away; the shop keeps selling and nothing is processed | infrastructure failure / outbox resilience | docker | kafka |
| [`ec-04-inventory-db-down`](../ecom-lab/scenarios/ec-04-inventory-db-down/scenario.yaml) | The inventory database stops; purchases hang instead of failing | dependency failure / slow failure | docker | postgres-inventory |
| [`ec-05-cache-down`](../ecom-lab/scenarios/ec-05-cache-down/scenario.yaml) | The projection cache is down and catalog/order reads hang | dependency failure / missing timeouts | docker | redis-projection |
| [`ec-06-gateway-secret-drift`](../ecom-lab/scenarios/ec-06-gateway-secret-drift/scenario.yaml) | One backend rejects the gateway after a secret rotation | configuration drift | docker | inventory-service |
| [`ec-07-db-credential-drift`](../ecom-lab/scenarios/ec-07-db-credential-drift/scenario.yaml) | order-service holds the old database password and stays down | deployment / configuration drift | docker | order-service |
| [`ec-08-heap-too-small`](../ecom-lab/scenarios/ec-08-heap-too-small/scenario.yaml) | An undersized heap lets reads work and kills inventory on the first purchase burst | resource sizing / OOM | docker | inventory-service |
| [`ec-09-shared-egress-ip`](../ecom-lab/scenarios/ec-09-shared-egress-ip/scenario.yaml) | Everyone behind one IP is rate-limited as a single client | protective control misfire / capacity | docker | api-gateway |
| [`ll-00-baseline`](../ledgerline/scenarios/ll-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | — | — |
| [`ll-01-pool-starvation-cycle`](../ledgerline/scenarios/ll-01-pool-starvation-cycle/scenario.yaml) | Two healthy services wait on each other and nothing looks busy | circular dependency / resource starvation | local-process | accounts <-> fraud-screening (cycle) |
| [`ll-02-provider-outage`](../ledgerline/scenarios/ll-02-provider-outage/scenario.yaml) | Third-party outage with a circuit breaker -- the silence is the symptom | external dependency failure / partial outage | local-process | fx-provider |
| [`ll-03-hot-row`](../ledgerline/scenarios/ll-03-hot-row/scenario.yaml) | Every transfer in the bank queues on one row | lock contention / data skew | local-process | ledger-db |
| [`ll-04-connection-budget`](../ledgerline/scenarios/ll-04-connection-budget/scenario.yaml) | Pools that are each reasonable add up to more than the database allows | capacity planning / connection exhaustion | local-process (exhaustion reproduced; the restart/failover amplification is documented but NOT reproduced locally) | ledger-db |
| [`ll-05-batch-oom`](../ledgerline/scenarios/ll-05-batch-oom/scenario.yaml) | The month-end job that kills itself, restarts, and tries again | data skew / batch memory / restart loop | docker + local-process | statements-worker |
| [`ll-06-shadow-dependency`](../ledgerline/scenarios/ll-06-shadow-dependency/scenario.yaml) | fraud-screening quietly depends on fx-rates | undocumented dependency | local-process (flag path) | — |
| [`sf-00-baseline`](../shopflow/scenarios/sf-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | — | — |
| [`sf-01-missing-index`](../shopflow/scenarios/sf-01-missing-index/scenario.yaml) | Order history is fast in staging, melts the database in production | capacity / data volume | local-process | orders-db |
| [`sf-02-cache-thrash`](../shopflow/scenarios/sf-02-cache-thrash/scenario.yaml) | Cache sized for staging evicts itself in production | capacity / infrastructure sizing | local-process | catalog-cache |
| [`sf-03-unbounded-cache`](../shopflow/scenarios/sf-03-unbounded-cache/scenario.yaml) | Memory climbs for an hour, then the container is OOM-killed | resource leak (configuration-induced) | docker + local-process | cart |
| [`sf-04-retry-storm`](../shopflow/scenarios/sf-04-retry-storm/scenario.yaml) | A third party throttles us; our own retries make it ten times worse | cascading failure / retry amplification | local-process | psp-sandbox |
| [`sf-05-secret-rotation`](../shopflow/scenarios/sf-05-secret-rotation/scenario.yaml) | Rotated database password; one service still has the old one | deployment / configuration drift | docker | orders |
| [`sf-06-shadow-dependency`](../shopflow/scenarios/sf-06-shadow-dependency/scenario.yaml) | A dependency that exists only in the code | undocumented dependency / hidden blast radius | local-process | — |
| [`sf-07-dead-dependency`](../shopflow/scenarios/sf-07-dead-dependency/scenario.yaml) | A declared dependency nobody calls | stale configuration / wasted capacity | compose-validated | — |
| [`sf-08-noisy-neighbor`](../shopflow/scenarios/sf-08-noisy-neighbor/scenario.yaml) | A reporting job on the shared database slows checkout | shared infrastructure contention | local-process (direction confirmed; magnitude depends on host cores -- compose caps catalog-db at 1 CPU) | catalog-db |
| [`sf-09-cpu-throttle`](../shopflow/scenarios/sf-09-cpu-throttle/scenario.yaml) | Slow but healthy -- a container throttled at a quarter of a core | resource sizing / CFS throttling | docker | catalog |
| [`sf-10-poison-message`](../shopflow/scenarios/sf-10-poison-message/scenario.yaml) | One un-processable message stops every confirmation e-mail | asynchronous failure / silent degradation | local-process | notifier |
| [`sf-11-wrong-hostname`](../shopflow/scenarios/sf-11-wrong-hostname/scenario.yaml) | A renamed service still referenced by its old name | configuration drift / silent degradation | local-process | — |

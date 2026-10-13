#!/usr/bin/env python3
"""Generates <subject>/docker-compose.obs.yml and <subject>/observability/** (Prometheus, Loki, Promtail, cAdvisor, Grafana + dashboard).
Run from test-subjects/:  python3 lab/gen-observability.py   -- the outputs are committed; this is the single place to change them."""
import json, os, textwrap

SUBJECTS = {
 'shopflow': dict(title='ShopFlow test bench', gateway='api-gateway', gw_port=8080, services={
   'catalog':3001,'cart':3002,'inventory':3003,'payments':3004,'orders':3005,'notifier':3006,'psp-sandbox':4000},
   extra=[('DB pool waiting (orders)', 'db_pool_waiting{job="orders"}', 'queries waiting for a pooled connection'),
          ('Unconsumed order events (notifier)', 'queue_pending_messages{job="notifier"}', 'JetStream backlog for the notifier consumer')]),
 'ledgerline': dict(title='LedgerLine test bench', gateway='edge', gw_port=8081, services={
   'accounts':3101,'transfers':3102,'ledger':3103,'fraud-screening':3104,'fx-rates':3105,'statements-worker':3106,'fx-provider':4100},
   extra=[('DB pool waiting (ledger)', 'db_pool_waiting{job="ledger"}', 'queries waiting for a pooled connection'),
          ('FX circuit open', 'fx_circuit_open{job="fx-rates"}', '1 while the FX vendor circuit breaker is open')]),
}
def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, 'w').write(text)

for S, c in SUBJECTS.items():
    base = S
    # ---------------------------------------------------------------- compose (separate project: <subject>-obs)
    w(f'{base}/docker-compose.obs.yml', f"""# {S} observability: a SEPARATE compose project ({S}-obs) that attaches to the application's network.
# Kept apart on purpose: the application project stays exactly what a mapper should discover, and monitoring can be started/stopped independently.
#   make obs-up   |   make obs-down        (needs the app project to be running first: it joins the {S}_default network)
# Everything listens on 127.0.0.1 only -- reach it through an SSH tunnel:  ssh -L 3000:localhost:3000 -L 9090:localhost:9090 <host>
name: {S}-obs

services:
  prometheus:
    image: prom/prometheus:v3.2.1
    restart: always
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=24h", "--web.enable-lifecycle"]
    ports: ["127.0.0.1:9090:9090"]
    volumes: ["./observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
    networks: [default, app]
    mem_limit: 192m

  docker-exporter:               # per-container CPU / memory / network / restarts / OOM / health, from the Docker API (same numbers as `docker stats`)
    image: {S}/docker-exporter:dev
    build: ./observability/exporter
    restart: always
    environment: {{ PROJECT: {S} }}
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [default]
    mem_limit: 64m

  loki:
    image: grafana/loki:3.4.2
    restart: always
    command: ["-config.file=/etc/loki/loki.yml"]
    volumes: ["./observability/loki.yml:/etc/loki/loki.yml:ro", "loki-data:/loki"]
    networks: [default]
    mem_limit: 192m

  promtail:                      # ships every {S} container's stdout/stderr (JSON lines) to Loki
    image: grafana/promtail:3.4.2
    restart: always
    command: ["-config.file=/etc/promtail/promtail.yml"]
    volumes: ["./observability/promtail.yml:/etc/promtail/promtail.yml:ro", "/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [default]
    depends_on: [loki]
    mem_limit: 96m

  grafana:
    image: grafana/grafana:11.5.2
    restart: always
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${{GRAFANA_PASSWORD:-bench}}
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
      GF_USERS_DEFAULT_THEME: dark
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/bench.json
    ports: ["127.0.0.1:3000:3000"]
    volumes: ["./observability/grafana/provisioning:/etc/grafana/provisioning:ro", "./observability/grafana/dashboards:/var/lib/grafana/dashboards:ro", "grafana-data:/var/lib/grafana"]
    networks: [default]
    depends_on: [prometheus, loki]
    mem_limit: 192m

networks:
  app: {{ external: true, name: {S}_default }}

volumes: {{ loki-data: {{}}, grafana-data: {{}} }}
""")
    # ---------------------------------------------------------------- prometheus
    targets = ''.join(f"  - {{ job_name: {n}, static_configs: [{{ targets: [\"{n}:{p}\"] }}] }}\n" for n, p in c['services'].items())
    w(f'{base}/observability/prometheus.yml', f"""# Job name == service name, so each series is attributed to the right service (and to the mapper's Tier-2 source, which reads the `job` label).
global: {{ scrape_interval: 5s, evaluation_interval: 5s }}
scrape_configs:
{targets}  - {{ job_name: docker, static_configs: [{{ targets: ["docker-exporter:9200"] }}] }}
""")
    import shutil
    os.makedirs(f'{base}/observability/exporter', exist_ok=True)
    shutil.copy('lab/docker-exporter.js', f'{base}/observability/exporter/index.js')
    w(f'{base}/observability/exporter/Dockerfile', '''# Prometheus exporter for one compose project, reading the Docker API. Runs as root only because the docker socket requires it (read-only mount).
FROM node:22-alpine
WORKDIR /app
COPY index.js .
EXPOSE 9200
CMD ["node", "index.js"]
''')
    # ---------------------------------------------------------------- loki / promtail
    w(f'{base}/observability/loki.yml', """auth_enabled: false
server: { http_listen_port: 3100 }
common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage: { filesystem: { chunks_directory: /loki/chunks, rules_directory: /loki/rules } }
  replication_factor: 1
  ring: { kvstore: { store: inmemory } }
schema_config:
  configs:
    - { from: 2024-01-01, store: tsdb, object_store: filesystem, schema: v13, index: { prefix: index_, period: 24h } }
limits_config:
  retention_period: 24h
  reject_old_samples: true
  reject_old_samples_max_age: 24h
compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
analytics: { reporting_enabled: false }
""")
    w(f'{base}/observability/promtail.yml', f"""server: {{ http_listen_port: 9080, grpc_listen_port: 0 }}
positions: {{ filename: /tmp/positions.yaml }}
clients: [{{ url: "http://loki:3100/loki/api/v1/push" }}]
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
        filters: [{{ name: label, values: ["com.docker.compose.project={S}"] }}]
    relabel_configs:
      - {{ source_labels: ["__meta_docker_container_label_com_docker_compose_service"], target_label: service }}
      - {{ source_labels: ["__meta_docker_container_name"], regex: "/(.*)", target_label: container }}
    pipeline_stages:
      - json: {{ expressions: {{ level: level, route: route, status: status }} }}
      - labels: {{ level: }}
""")
    # ---------------------------------------------------------------- grafana provisioning
    w(f'{base}/observability/grafana/provisioning/datasources/datasources.yml', """apiVersion: 1
datasources:
  - { name: Prometheus, uid: prom, type: prometheus, access: proxy, url: http://prometheus:9090, isDefault: true, jsonData: { timeInterval: 5s } }
  - { name: Loki, uid: loki, type: loki, access: proxy, url: http://loki:3100 }
""")
    w(f'{base}/observability/grafana/provisioning/dashboards/dashboards.yml', """apiVersion: 1
providers:
  - { name: bench, type: file, disableDeletion: true, updateIntervalSeconds: 30, options: { path: /var/lib/grafana/dashboards } }
""")
    # ---------------------------------------------------------------- dashboard
    NAME = f'name=~"{S}-.*"'
    panels = []; pid = [0]
    def nid(): pid[0] += 1; return pid[0]
    def target(expr, legend='', ds='prom'): return {'datasource': {'type': 'prometheus' if ds == 'prom' else 'loki', 'uid': ds}, 'expr': expr, 'legendFormat': legend, 'refId': 'A'}
    def row(title, y): panels.append({'type': 'row', 'title': title, 'id': nid(), 'gridPos': {'h': 1, 'w': 24, 'x': 0, 'y': y}, 'collapsed': False})
    def stat(title, expr, x, y, unit='short', thresholds=None, desc=''):
        panels.append({'type': 'stat', 'title': title, 'description': desc, 'id': nid(), 'gridPos': {'h': 4, 'w': 4, 'x': x, 'y': y}, 'datasource': {'type': 'prometheus', 'uid': 'prom'},
          'targets': [target(expr)], 'fieldConfig': {'defaults': {'unit': unit, 'thresholds': {'mode': 'absolute', 'steps': thresholds or [{'color': 'green', 'value': None}]}}, 'overrides': []},
          'options': {'colorMode': 'background', 'graphMode': 'area', 'reduceOptions': {'calcs': ['lastNotNull']}}})
    def ts(title, expr, legend, x, y, w_=12, h=8, unit='short', desc='', ds='prom', stack=False):
        panels.append({'type': 'timeseries', 'title': title, 'description': desc, 'id': nid(), 'gridPos': {'h': h, 'w': w_, 'x': x, 'y': y}, 'datasource': {'type': 'prometheus', 'uid': 'prom'},
          'targets': [target(expr, legend)], 'fieldConfig': {'defaults': {'unit': unit, 'custom': {'lineWidth': 2, 'fillOpacity': 12, 'stacking': {'mode': 'normal' if stack else 'none'}}}, 'overrides': []},
          'options': {'legend': {'displayMode': 'table', 'placement': 'bottom', 'calcs': ['lastNotNull', 'max']}, 'tooltip': {'mode': 'multi'}}})
    CNT = 'http_server_request_duration_seconds_count'; BKT = 'http_server_request_duration_seconds_bucket'
    row('Health at a glance', 0)
    stat('Requests / s (services)', f'sum(rate({CNT}[1m]))', 0, 1, 'reqps')
    stat('5xx ratio', f'(sum(rate({CNT}{{http_response_status_code=~"5.."}}[1m])) or vector(0)) / sum(rate({CNT}[1m]))', 4, 1, 'percentunit',
         [{'color': 'green', 'value': None}, {'color': 'orange', 'value': 0.01}, {'color': 'red', 'value': 0.05}], 'share of requests answered 5xx')
    stat('p95 latency (worst service)', f'max(histogram_quantile(0.95, sum by (job, le) (rate({BKT}[1m]))))', 8, 1, 's',
         [{'color': 'green', 'value': None}, {'color': 'orange', 'value': 0.5}, {'color': 'red', 'value': 2}])
    stat('Containers running', 'sum(container_running)', 12, 1, 'short', [{'color': 'red', 'value': None}, {'color': 'green', 'value': 1}], 'containers of this project that are running')
    stat('Restarts (15 min)', 'sum(changes(container_started_timestamp_seconds[15m]))', 16, 1, 'short',
         [{'color': 'green', 'value': None}, {'color': 'red', 'value': 1}], 'container (re)starts in the last 15 minutes')
    stat('Memory in use', 'sum(container_memory_usage_bytes)', 20, 1, 'bytes')
    row('Requests (from each service\'s own /metrics)', 5)
    ts('Request rate by service', f'sum by (job) (rate({CNT}[1m]))', '{{job}}', 0, 6, 12, 8, 'reqps')
    ts('Error rate by service (5xx)', f'sum by (job) (rate({CNT}{{http_response_status_code=~"5.."}}[1m]))', '{{job}}', 12, 6, 12, 8, 'reqps', 'a service raising 5xx')
    ts('p95 latency by service', f'histogram_quantile(0.95, sum by (job, le) (rate({BKT}[1m])))', '{{job}}', 0, 14, 12, 8, 's')
    ts('Client errors by service (4xx)', f'sum by (job, http_response_status_code) (rate({CNT}{{http_response_status_code=~"4.."}}[1m]))', '{{job}} {{http_response_status_code}}', 12, 14, 12, 8, 'reqps', '401/403/404/409/429 never show as 5xx')
    row('Containers (Docker API)', 22)
    ts('CPU by container (100% = one core)', 'container_cpu_percent', '{{service}}', 0, 23, 12, 9, 'percent')
    ts('Memory vs limit', 'container_memory_percent', '{{service}}', 12, 23, 12, 9, 'percent', 'above ~85% a JVM/Node process is close to being OOM-killed')
    ts('Network received', 'sum by (service) (rate(container_network_receive_bytes_total[1m]))', '{{service}}', 0, 32, 12, 8, 'Bps')
    ts('Network transmitted', 'sum by (service) (rate(container_network_transmit_bytes_total[1m]))', '{{service}}', 12, 32, 12, 8, 'Bps')
    row('Application internals', 40)
    xs = 0
    for title, expr, desc in c['extra']:
        ts(title, expr, '{{job}}', xs, 41, 12, 8, 'short', desc); xs += 12
    ts('Process memory (RSS)', 'process_resident_memory_bytes', '{{job}}', 0, 49, 12, 8, 'bytes')
    ts('Node.js heap used', 'nodejs_heap_used_bytes', '{{job}}', 12, 49, 12, 8, 'bytes')
    row('Logs (Loki)', 57)
    panels.append({'type': 'timeseries', 'title': 'Error log lines / s by service', 'id': nid(), 'gridPos': {'h': 8, 'w': 24, 'x': 0, 'y': 58}, 'datasource': {'type': 'loki', 'uid': 'loki'},
      'targets': [target('sum by (service) (count_over_time({level=~"error|fatal|warn"}[1m])) / 60', '{{service}}', 'loki')], 'fieldConfig': {'defaults': {'unit': 'short', 'custom': {'lineWidth': 2, 'fillOpacity': 10}}, 'overrides': []},
      'options': {'legend': {'displayMode': 'table', 'placement': 'bottom', 'calcs': ['lastNotNull', 'max']}}})
    panels.append({'type': 'logs', 'title': 'Warnings and errors', 'id': nid(), 'gridPos': {'h': 10, 'w': 24, 'x': 0, 'y': 66}, 'datasource': {'type': 'loki', 'uid': 'loki'},
      'targets': [{'datasource': {'type': 'loki', 'uid': 'loki'}, 'expr': '{level=~"error|fatal|warn"}', 'refId': 'A'}], 'options': {'showTime': True, 'wrapLogMessage': True, 'sortOrder': 'Descending'}})
    dash = {'uid': 'bench', 'title': c['title'], 'tags': ['test-bench', S], 'timezone': 'browser', 'schemaVersion': 39, 'version': 1, 'refresh': '5s', 'time': {'from': 'now-15m', 'to': 'now'},
            'annotations': {'list': [{'name': 'Scenario changes', 'enable': True, 'iconColor': 'orange', 'datasource': {'type': 'grafana', 'uid': '-- Grafana --'}, 'target': {'type': 'tags', 'tags': ['scenario'], 'limit': 100}}]},
            'panels': panels}
    w(f'{base}/observability/grafana/dashboards/bench.json', json.dumps(dash, indent=1))
print('generated', ', '.join(SUBJECTS))

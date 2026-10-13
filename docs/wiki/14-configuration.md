# Configuration Reference

---

## Server — `server/config.ts`

```typescript
export const config = {
  PORT:                    3001,
  POLLING_INTERVAL_MS:     5000,
  METRIC_HISTORY_SIZE:     720,
  INGEST_TOKEN:            'mapper-secret-token',
  SOCK_SHOP_BASE_URL:      '',
  SOCK_SHOP_COMPOSE_PATH:  './sock-shop-docker-compose.yml',
  VERTIKAL_BASE_URL:       '',
  VERTIKAL_COMPOSE_PATH:   '../vertikal/docker-compose.yml',
};
```

Override any value with an environment variable:

| Env Var | Default | Effect |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket server port |
| `POLLING_INTERVAL_MS` | `5000` | RCA evaluation + graph broadcast interval |
| `METRIC_HISTORY_SIZE` | `720` | Ring buffer depth per node (~1 hour at 5s) |
| `INGEST_TOKEN` | `mapper-secret-token` | Bearer token for `POST /api/ingest` |
| `SOCK_SHOP_BASE_URL` | `''` | Sock Shop HTTP endpoint for health pings |
| `VERTIKAL_BASE_URL` | `''` | Vertikal HTTP endpoint for health pings |

---

## Remote Collector — Environment Variables

Set on the EC2 instance before starting the collector:

| Env Var | Default | Description |
|---|---|---|
| `MAPPER_URL` | `http://127.0.0.1:3001` | Backend ingest URL (via SSH reverse tunnel) |
| `INGEST_TOKEN` | `mapper-secret-token` | Must match server's `INGEST_TOKEN` |
| `TARGET_ID` | `sock-shop-aws` | Sent in every `TelemetryEnvelope.targetId` |
| `ENVIRONMENT` | `aws` | Deployment environment label |
| `REGION` | `ap-south-1` | AWS region label |
| `POLLING_INTERVAL` | `5000` | Collection cycle in milliseconds |

---

## Target SSH Config — `data/remote_config.json`

Written by the UI (`RemoteConfigPanel`) or manually. Loaded by `GraphStore.loadTargetsFromConfig()` at startup.

```json
{
  "sock-shop": {
    "displayName":  "Sock Shop AWS",
    "ec2PublicIp":  "18.206.136.26",
    "sshUsername":  "ubuntu",
    "sshKeyPath":   "~/.ssh/sockshop-key.pem",
    "baseUrl":      "http://18.206.136.26:80"
  },
  "vertikal": {
    "displayName":  "Vertikal AWS",
    "ec2PublicIp":  "54.221.33.11",
    "sshUsername":  "ubuntu",
    "sshKeyPath":   "~/.ssh/vertikal-key.pem",
    "baseUrl":      "http://54.221.33.11:54321"
  }
}
```

**`sshKeyPath` supports `~/`** — expanded via `path.join(os.homedir(), ...)`. No passphrase-protected keys (would require `ssh-agent` integration).

**`baseUrl`** — used for HTTP health pings. Optional but recommended. If absent, `endpointStatus` stays `UNCONFIGURED`.

**`trafficBaseUrl`** (optional) — pins the URL traffic is actually sent to,
overriding what discovery infers. Set it from the **Entry point** control in
the Traffic panel, or via `POST /api/traffic/entrypoint`.

It exists because discovery can only report what a container *publishes*,
which is not the same as what is *reachable from where the app runs*. Two
real cases:

- A published port is closed in the security group, so the inferred URL
  times out forever while an SSH forward (`http://localhost:18080`) works.
- Discovery picks the alphabetically-first endpoint, which can be a
  telemetry port — a DeathStarBench box resolved to Jaeger's OTLP `:4318`
  rather than the app's own entry.

`GET /api/traffic/entrypoints` flags a pin whose host no longer matches the
target's current `ec2PublicIp` (`staleHost`), because these instances get a
new public IP on every stop/start.

Note that `POST /api/config/remote` **merges** into the existing entry rather
than replacing it, specifically so that updating an IP does not silently
erase this key.

---

## ML Pipeline — `ml/config.json`

Defaults live in `ml/mlconfig.py`. `collector.py` and `score.py` re-read this
file every cycle, so changes to their keys take effect within one cycle with
no restart. `preprocess.py` and `train.py` read it once at startup, so their
keys only apply on the next **Retrain**.

```json
{
  "collect_interval_sec": 10,
  "min_samples_per_service": 10,
  "min_training_samples": 30,
  "contamination": 0.01,
  "score_interval_sec": 10,
  "persistence_windows": 3,
  "n_estimators": 200,
  "max_samples_fraction": 1.0,
  "holdout_fraction": 0.2,
  "feature_columns": [
    "z_cpu_percent", "z_memory_percent",
    "z_network_rx_rate", "z_network_tx_rate"
  ]
}
```

| Key | Default | Applies | Description |
|---|---|---|---|
| `collect_interval_sec` | `10` | live | How often `collector.py` polls `/api/graph` |
| `min_samples_per_service` | `10` | retrain | Below this, a service is skipped when building features |
| `min_training_samples` | `30` | retrain | Below this, a service gets no model |
| `contamination` | `0.01` | retrain | Expected anomaly fraction. Must be `< 0.5` — an IsolationForest requirement |
| `score_interval_sec` | `10` | live | How often `score.py` re-scores |
| `persistence_windows` | `3` | live | Consecutive above-threshold windows before flagging a real anomaly |
| `n_estimators` | `200` | retrain | Trees per forest |
| `max_samples_fraction` | `1.0` | retrain | Fraction of training rows each tree draws. `1.0` = sklearn `auto` |
| `holdout_fraction` | `0.2` | retrain | Chronological tail held out of training. `0` = train on everything |
| `feature_columns` | all four | retrain | Which `z_*` features to fit on. Must be a non-empty subset |

All of these are editable from the **ML Pipeline** page; the API validates
them (`POST /api/ml/config`).

### The holdout is not an accuracy figure

`holdout_fraction` splits **chronologically**, not randomly: the model fits
the earlier part of each service's data and is then scored on the tail it
never saw. A random split would leak adjacent samples across the boundary
and flatter the result.

The tail is unlabelled, so what comes back is a **firing rate**, not an error
rate — "how often does this model fire on data it never saw". Compare it to
`contamination`: much higher suggests drift or a tail that was not actually
normal. It is reported per model in `models/*.meta.json` and in the
`Holdout flagged` column on the ML Pipeline page.

---

## Data Files — Auto-Created at Runtime

| File | Created when | Description |
|---|---|---|
| `data/graph_db.json` | First time graph state is saved | Full graph snapshot |
| `data/remote_config.json` | First target registered | SSH configs |
| `data/traces_<targetId>.json` | First TCP events received for a target | 24-hour TCP event log |
| `data/experiments.json` | First experiment started | Experiment history |
| `ml/data/metrics_raw.csv` | `ml/collector.py` first run | Raw metrics time series |
| `ml/data/features.csv` | `ml/preprocess.py` first run | Normalized features |
| `ml/data/normalization_stats.json` | `ml/preprocess.py` | Per-service normalization params |
| `ml/data/latest_scores.json` | `ml/score.py` first run | Current anomaly scores |
| `ml/models/*.joblib` | `ml/train.py` | Serialized IsolationForest per service |

**To reset graph state completely:** `rm data/graph_db.json` — targets will be re-discovered from `remote_config.json` on next startup.

**To reset everything:** `rm -rf data/ ml/data/ ml/models/`

---

## Frontend — `client/vite.config.ts`

The Vite dev server proxies API calls to the backend:

```typescript
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws':  { target: 'ws://localhost:3001', ws: true },
    },
  },
});
```

This means in development, `fetch('/api/graph')` from the React app hits the backend on `:3001`. In production (served by NGINX), the proxy is replaced by NGINX `location` blocks.

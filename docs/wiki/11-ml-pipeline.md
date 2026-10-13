# ML Anomaly Detection Pipeline

**Directory:** `ml/`

---

## What It Is

A standalone Python sidecar that trains a per-service `IsolationForest` on historical metrics collected from the mapper's API, then runs a live scoring loop that writes anomaly scores to disk. The Node.js server reads this output file. They never communicate directly.

**It is entirely optional.** The mapper works without it — nodes will just have no `anomalyScore` in their `analytics` field.

---

## Why Isolation Forest?

- **Unsupervised:** No labeled "normal" vs "anomalous" data exists. We only have raw metrics.
- **Efficient:** Trains quickly on tabular data. Low memory footprint.
- **Interpretable:** "This score of 0.85 means the model thinks this combination of CPU+memory+network is far from what it normally sees."
- **Per-service models:** Each service has its own model trained on its own metric distribution. `catalogue-db` behaves differently from `front-end` — a shared model would conflate them.

---

## Pipeline Stages

### Stage 1 — `collector.py`

Polls `GET /api/graph` every 10 seconds. Extracts `node.metrics` for all nodes and appends rows to `data/metrics_raw.csv`.

```python
# Output columns:
# timestamp, service_id, cpu, memory_percent, network_rx, network_tx
```

**Why not use MetricStore?** `MetricStore` is a ring buffer that holds ~1 hour. Training requires days or weeks of baseline data to learn "normal" behavior. The collector writes an append-only CSV that grows with time.

**When to start:** As soon as possible, during **normal operation** (no active stress tests or incidents). The more baseline data before training, the better the models.

### Stage 2 — `preprocess.py`

```python
# 1. Load metrics_raw.csv
# 2. Convert cumulative networkRx/networkTx counters → rates (Δ bytes/second)
#    (The mapper reports cumulative bytes, not rates)
# 3. Per-service z-score normalization
#    (Each feature normalized independently per service)
# 4. Output: data/features.csv + data/normalization_stats.json
```

**Why z-score normalization?** `catalogue-db` might use 500MB of memory normally; `front-end` uses 80MB. Without per-service normalization, `catalogue-db` would always look "anomalous" relative to the fleet average.

**Why convert to rates?** `networkRx` as a cumulative counter always grows. An `IsolationForest` trained on cumulative values would flag new deployments (where counts reset) as anomalous. Rates (Δ per second) are stationary.

### Stage 3 — `train.py`

```python
from sklearn.ensemble import IsolationForest
import joblib

for service_id in services_with_enough_data:
    X = features[features['service_id'] == service_id].drop(['timestamp', 'service_id'], axis=1)
    if len(X) < MIN_TRAINING_SAMPLES:  # 30
        continue
    model = IsolationForest(contamination=0.05, random_state=42)
    model.fit(X)
    joblib.dump(model, f'models/{service_id}.joblib')
```

**`contamination=0.05`:** Tells IsolationForest to expect ~5% anomalies in training data. If you trained on completely clean data, use `contamination='auto'`.

**Excluding incident windows:**
```bash
# Exclude a known stress test from training data:
python3 train.py --since 2026-09-17T00:00:00Z --until 2026-09-17T02:00:00Z
```
The `--since`/`--until` range is **excluded** from training. Data outside this range is used.

### Stage 4 — `score.py`

```python
# Live loop:
while True:
    graph = fetch_api('/api/graph')
    
    for node in graph['nodes']:
        service_id = node['id']
        model = load_model(f'models/{service_id}.joblib')
        
        features = normalize(extract_features(node['metrics']))
        raw_score = model.score_samples([features])[0]
        
        # IsolationForest: lower score = more anomalous
        # Convert to [0,1] where 1 = most anomalous
        anomaly_score = 1 - (raw_score - min_score) / (max_score - min_score)
        
        # Track consecutive above-threshold windows
        if anomaly_score > threshold:
            consecutive_windows[service_id] += 1
        else:
            consecutive_windows[service_id] = 0
        
        persistent = consecutive_windows[service_id] >= PERSISTENT_WINDOWS  # 3
    
    # Write all scores atomically
    with open('data/latest_scores.json', 'w') as f:
        json.dump(scores, f)
    
    time.sleep(10)
```

**Persistent anomaly:** Requiring `N` consecutive above-threshold windows before declaring a persistent anomaly reduces false positives from brief metric spikes (a GC pause, a one-time burst). The threshold is configurable via `ml/config.json`.

---

## Running It From the UI

The two long-running stages (`collector.py`, `score.py`) are supervised from
the **ML Pipeline** page rather than only from a shell:

| Control | Endpoint | Notes |
|---|---|---|
| Start / Stop collector | `POST /api/ml/processes/collector/{start,stop}` | Writes to `ml/logs/collector.log` |
| Start / Stop scorer | `POST /api/ml/processes/scorer/{start,stop}` | Writes to `ml/logs/scorer.log` |
| Status | `GET /api/ml/processes` | Running, pid, uptime, log tail |
| Retrain | `POST /api/ml/retrain` | Runs `preprocess.py` then `train.py`, streaming the log |

This exists because the numbers on the page are only meaningful if you know
whether anything is still producing them. A stopped collector leaves every
figure frozen at its last write, which is indistinguishable from "the system
is quiet" unless the process state is visible.

**Externally-started processes are detected too.** `GET /api/ml/processes`
falls back to an anchored `pgrep` (`^python3 collector\.py$`), so a run
launched from a terminal is reported honestly and can still be stopped from
the UI. The anchor matters: without it the match also hits shell wrappers
whose command line merely *contains* `python3 collector.py`, and stopping the
wrapper would leave the interpreter running.

---

## Tuning Knobs

All editable from the page, all genuinely wired into the Python — see
[14-configuration](14-configuration.md) for the full table.

- `n_estimators`, `max_samples_fraction` → passed to `IsolationForest`
- `feature_columns` → which `z_*` features are fitted. `score.py` reads each
  model's own recorded `feature_columns` from its `meta.json`, so a
  subset-trained model is scored with the vector it was fitted on rather
  than silently mismatched
- `holdout_fraction` → chronological train/test split (see below)
- Training window (`--since` / `--until`) → restrict training to a period you
  know was baseline-only

### Holdout evaluation

With `holdout_fraction > 0`, `train.py` fits on the earlier part of each
service's series and scores the held-out tail, recording in `meta.json`:

```json
"holdout": {
  "samples": 392,
  "flag_rate": 0.0,
  "mean_score": -0.328,
  "max_score": -0.328,
  "from": "…", "to": "…"
}
```

The split is chronological, not random — a random split leaks adjacent
samples across the boundary and flatters the result. The tail is unlabelled,
so `flag_rate` is a **firing rate, not an accuracy**: how often the model
fires on data it never saw. Compare it against `contamination`; much higher
suggests drift or a tail that was not actually normal.

---

## Server Integration

`GraphStore.readAnomalyScores()` — called inside `getGraph()` before each response:

```typescript
private readAnomalyScores(): Record<string, any> {
  const scoresPath = path.join('..', 'ml', 'data', 'latest_scores.json');
  try {
    const stat = fs.statSync(scoresPath);
    if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
      return this.anomalyScoresCache.data;  // Unchanged — return cache
    }
    const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
    this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return {};  // File missing or invalid = no scores
  }
}
```

The mtime check costs ~0.1ms. JSON parsing costs ~1–10ms. Scores are written every 10 seconds → ~7200 mtime checks per day, ~720 actual parses. Negligible overhead.

**Expected file format:**
```json
{
  "sock-shop:catalogue": { "anomaly_score": 0.85, "persistent": true },
  "sock-shop:payment":   { "anomaly_score": 0.42, "persistent": false }
}
```

Scores are applied to nodes in `getGraph()`:
```typescript
const s = scores[node.id];
if (s) {
  node.analytics = {
    ...node.analytics,
    anomalyScore:       s.anomaly_score,
    anomalyPersistent:  s.persistent,
  };
}
```

---

## Known Limitations (Honest)

These are stated in the source code comments and `ml/README.md`, not hidden.

**1. Unsupervised — no labeled data**
Training on data that includes an incident teaches the model that the incident is "normal." The `--since/--until` exclusion is the manual workaround. The system does not auto-detect incident windows.

**2. Minimum samples**
A service needs at least 30 samples after preprocessing (`MIN_TRAINING_SAMPLES` in `train.py`) before it gets a model. New targets won't have anomaly scores until they've been observed for several minutes.

**3. Feature set is limited**
Only CPU, memory, and network rate are used. HTTP latency and error rate fields are `null` almost everywhere in current telemetry — Docker stats don't include HTTP metrics, and most services' logs aren't parsed. Adding these as features before they're populated would mean training on fabricated zeros.

**4. No auto-retraining**
Must manually re-run `preprocess.py` + `train.py` as data accumulates. A cron job like `0 3 * * * cd /path/to/ml && python3 preprocess.py && python3 train.py` handles this.

**5. The holdout is not accuracy**
`flag_rate` says how often a model fires on unseen data. Without labels there
is no way to call those firings right or wrong. It is useful as a relative
signal (compare to `contamination`, or across services), not as a score.

**6. `collector.py` and MetricStore overlap**
Both read `/api/graph`. The collector is standalone — it doesn't hook into MetricStore. This means there's some redundant API polling. The separation exists because the ML pipeline needs to be independently deployable (possibly on a different machine).

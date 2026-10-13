# Anomaly detection pipeline

Separate Python pipeline that trains a per-service Isolation Forest on the
metrics the Node app collects, and feeds live anomaly scores back into it.
Runs standalone — the Node server just reads `data/latest_scores.json` off
disk each time it builds the graph; nothing here is a hard dependency of
the mapper itself.

## Pipeline

```
collector.py   polls /api/graph every 10s, appends to data/metrics_raw.csv
      |        (append-only, growing dataset — the mapper's own MetricStore
      |         only keeps a rolling ~1h window, not useful for training)
      v
preprocess.py  batch job: cumulative network counters -> rates, per-service
      |        z-score normalization -> data/features.csv +
      |        data/normalization_stats.json
      v
train.py       fits one IsolationForest per service on its own normalized
      |        features -> models/<service>.joblib + <service>.meta.json
      v
score.py       live loop: scores each new sample with its service's model,
               requires N consecutive above-threshold windows before
               calling it a persistent anomaly -> data/latest_scores.json
```

## Running it

```bash
pip install -r requirements.txt

# start collecting now — the sooner this runs, the more baseline data you have
python3 collector.py &

# once you have a reasonable baseline window (a few hundred samples/service,
# collected during NORMAL operation — not mid stress-test):
python3 preprocess.py
python3 train.py                                    # or:
python3 train.py --since 2026-09-17T00:00:00Z --until 2026-09-17T02:00:00Z

# start live scoring
python3 score.py &
```

Re-run `preprocess.py` + `train.py` periodically as more baseline data
accumulates — nothing here auto-retrains.

## Known limitations (stated, not hidden)

- **Unsupervised, not "trained on confirmed-normal data"**: there's no
  labeled normal/anomaly split. `train.py --since/--until` is how you
  exclude a known stress-test window from training — point it at a range
  you know was quiet. If you train on data that includes an injected
  failure, the model learns that failure as normal.
- A service needs `MIN_TRAINING_SAMPLES` (30, in `train.py`) after
  preprocessing before it gets a model at all — new targets (e.g. a
  freshly-discovered project) won't have anomaly scores until they've been
  collected for a while.
- CPU/memory/network-rate are the only features right now — no HTTP
  latency/error-rate features yet (that data is `errorRate: null` /
  `latency: null` almost everywhere in the current telemetry; adding it
  as a feature before it's actually populated would mean training on
  fabricated zeros).

#!/usr/bin/env python3
"""
Live anomaly scoring loop. For each service with a trained model:
  1. Pull its latest sample from the Node app's API.
  2. Normalize it using the SAME per-service mean/std saved at training time
     (never recomputed from live data — that would silently drift the
     definition of "normal" every cycle).
  3. Score it with that service's IsolationForest.
  4. Track consecutive windows above the trained threshold; only declare a
     persistent anomaly event after PERSISTENCE_WINDOWS in a row, so a
     single noisy sample doesn't fire an alert.

Writes data/latest_scores.json every cycle:
  { "<service_id>": {
      "anomaly_score": 0..1, "above_threshold": bool,
      "consecutive_windows": int, "persistent": bool,
      "scored_at": iso timestamp
  }, ... }

Node reads this file directly — no second HTTP server to run/coordinate.
A service with no model yet (not enough training data) is simply absent
from the output, not defaulted to a fake score.
"""

import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import joblib
import numpy as np

from mlconfig import load_config

MAPPER_URL = os.environ.get("MAPPER_URL", "http://localhost:3001")

BASE_DIR = os.path.dirname(__file__)
MODELS_DIR = os.path.join(BASE_DIR, "models")
STATS_PATH = os.path.join(BASE_DIR, "data", "normalization_stats.json")
OUT_PATH = os.path.join(BASE_DIR, "data", "latest_scores.json")
SUMMARY_PATH = os.path.join(BASE_DIR, "data", "scoring_summary.json")
HISTORY_PATH = os.path.join(BASE_DIR, "data", "score_history.csv")
HISTORY_MAX_ROWS = 50_000  # trimmed, not left to grow forever

FEATURE_RAW_COLUMNS = ["cpu_percent", "memory_percent", "network_rx_rate", "network_tx_rate"]


def load_models():
    models = {}
    if not os.path.isdir(MODELS_DIR):
        return models
    for fname in os.listdir(MODELS_DIR):
        if not fname.endswith(".meta.json"):
            continue
        with open(os.path.join(MODELS_DIR, fname)) as f:
            meta = json.load(f)
        safe_name = fname[: -len(".meta.json")]
        model_path = os.path.join(MODELS_DIR, f"{safe_name}.joblib")
        if not os.path.exists(model_path):
            continue
        models[meta["service_id"]] = {
            "model": joblib.load(model_path),
            "meta": meta,
        }
    return models


def fetch_graph():
    with urllib.request.urlopen(f"{MAPPER_URL}/api/graph", timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def append_history(results: dict):
    """Append-only log of every score, for the UI to chart trends over time.
    Trimmed to the last HISTORY_MAX_ROWS when it grows past ~2x that, so it
    doesn't grow forever, but trimming isn't attempted every single cycle."""
    is_new = not os.path.exists(HISTORY_PATH)
    with open(HISTORY_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["timestamp", "service_id", "anomaly_score", "above_threshold", "persistent"])
        for sid, r in results.items():
            writer.writerow([r["scored_at"], sid, r["anomaly_score"], r["above_threshold"], r["persistent"]])

    if is_new:
        return
    try:
        if os.path.getsize(HISTORY_PATH) > 8_000_000:  # ~8MB, well past HISTORY_MAX_ROWS worth of short rows
            with open(HISTORY_PATH) as f:
                lines = f.readlines()
            if len(lines) > HISTORY_MAX_ROWS + 1:
                header, rows = lines[0], lines[1:]
                trimmed = [header] + rows[-HISTORY_MAX_ROWS:]
                tmp = HISTORY_PATH + ".tmp"
                with open(tmp, "w") as f:
                    f.writelines(trimmed)
                os.replace(tmp, HISTORY_PATH)
    except Exception as e:
        print(f"[score] history trim failed (non-fatal): {e}", file=sys.stderr, flush=True)


def main():
    if not os.path.exists(STATS_PATH):
        print(f"[score] no normalization stats at {STATS_PATH} — run preprocess.py + train.py first", file=sys.stderr)
        sys.exit(1)

    with open(STATS_PATH) as f:
        stats = json.load(f)

    models = load_models()
    if not models:
        print(f"[score] no trained models in {MODELS_DIR} — run train.py first", file=sys.stderr)
        sys.exit(1)

    cfg = load_config()
    print(f"[score] loaded {len(models)} models, scoring every {cfg['score_interval_sec']}s, persistence={cfg['persistence_windows']}", flush=True)
    started_at = datetime.now(timezone.utc).isoformat()

    # prev cumulative network counters, to compute the same rate features
    # used in training (mirrors preprocess.py's diff logic, per service)
    prev_network = {}
    consecutive_above = {sid: 0 for sid in models}

    while True:
        cfg = load_config()  # re-read each cycle so a UI tweak (e.g. persistence window) applies live
        score_interval_sec = cfg["score_interval_sec"]
        persistence_windows = cfg["persistence_windows"]
        cycle_start = time.time()
        try:
            graph = fetch_graph()
            nodes_by_id = {n["id"]: n for n in graph.get("nodes", [])}
        except Exception as e:
            print(f"[score] fetch failed: {e}", file=sys.stderr, flush=True)
            time.sleep(score_interval_sec)
            continue

        now_ts = time.time()
        results = {}

        for service_id, entry in models.items():
            node = nodes_by_id.get(service_id)
            if not node or not node.get("metrics"):
                continue

            m = node["metrics"]
            rx, tx = m.get("networkRx"), m.get("networkTx")
            prev = prev_network.get(service_id)
            prev_network[service_id] = (now_ts, rx, tx)

            if prev is None or rx is None or tx is None:
                continue  # need a prior sample to compute a rate
            prev_ts, prev_rx, prev_tx = prev
            dt = now_ts - prev_ts
            if dt <= 0:
                continue
            rx_delta, tx_delta = rx - prev_rx, tx - prev_tx
            rx_rate = 0.0 if rx_delta < 0 else rx_delta / dt  # restart -> 0, not a fake spike
            tx_rate = 0.0 if tx_delta < 0 else tx_delta / dt

            raw = {
                "cpu_percent": m.get("cpu"),
                "memory_percent": m.get("memoryPercent"),
                "network_rx_rate": rx_rate,
                "network_tx_rate": tx_rate,
            }
            if any(v is None for v in raw.values()):
                continue

            service_stats = stats.get(service_id)
            if not service_stats:
                continue

            model = entry["model"]
            meta = entry["meta"]

            # Follow this model's own recorded feature list and order —
            # training can be configured to use a subset, and scoring a
            # model with a different vector than it was fitted on would be
            # silently wrong rather than an error.
            z = []
            skip = False
            for z_col in meta["feature_columns"]:
                col = z_col[2:] if z_col.startswith("z_") else z_col
                col_stats = service_stats.get(col)
                if col not in raw or not col_stats or col_stats["std"] <= 0:
                    skip = True
                    break
                z.append((raw[col] - col_stats["mean"]) / col_stats["std"])
            if skip:
                continue
            X = np.array([z])
            anomaly_raw = float(-model.decision_function(X)[0])
            threshold = meta["threshold_p99"]
            # squash to 0..1 relative to this service's own trained
            # threshold, purely for display — the real decision uses the
            # raw score vs threshold, not this squashed value
            anomaly_score = min(1.0, max(0.0, anomaly_raw / threshold)) if threshold > 0 else 0.0
            above = anomaly_raw >= threshold

            consecutive_above[service_id] = consecutive_above[service_id] + 1 if above else 0
            persistent = consecutive_above[service_id] >= persistence_windows

            results[service_id] = {
                "anomaly_score": round(anomaly_score, 4),
                "raw_score": round(anomaly_raw, 4),
                "threshold": round(threshold, 4),
                "above_threshold": above,
                "consecutive_windows": consecutive_above[service_id],
                "persistent": persistent,
                "scored_at": datetime.now(timezone.utc).isoformat(),
            }

        with open(OUT_PATH, "w") as f:
            json.dump(results, f, indent=2)
        if results:
            append_history(results)

        persistent_now = [sid for sid, r in results.items() if r["persistent"]]
        summary = {
            "started_at": started_at,
            "last_cycle_at": datetime.now(timezone.utc).isoformat(),
            "models_loaded": len(models),
            "services_scored_this_cycle": len(results),
            "persistence_windows_required": persistence_windows,
            "score_interval_sec": score_interval_sec,
            "persistent_anomalies_now": persistent_now,
        }
        tmp = SUMMARY_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(summary, f, indent=2)
        os.replace(tmp, SUMMARY_PATH)

        elapsed = time.time() - cycle_start
        print(f"[score] scored {len(results)}/{len(models)} services in {elapsed:.2f}s", flush=True)
        time.sleep(max(0.0, score_interval_sec - elapsed))


if __name__ == "__main__":
    main()

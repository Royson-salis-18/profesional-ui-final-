#!/usr/bin/env python3
"""
Batch preprocessing: metrics_raw.csv -> features.csv + normalization_stats.json

Steps, in order (mirrors the project's Phase 3 spec):
  1. Parse timestamps, sort per service.
  2. Convert the cumulative network counters into per-window rates. A
     negative delta means the container restarted (counter reset) — that
     window's rate is recorded as 0 and flagged, never a fake spike.
  3. Per-service z-score normalization (never global — 40% CPU is normal
     for one service, anomalous for another).
  4. Persist normalization_stats.json (per-service mean/std) so score.py
     can normalize new live samples the same way.

Rows with fewer than MIN_SAMPLES_PER_SERVICE observations are dropped from
training features (not enough history to compute a meaningful mean/std)
but this is logged, not silently swallowed.
"""

import json
import os
import sys

import numpy as np
import pandas as pd

from mlconfig import load_config

RAW_PATH = os.path.join(os.path.dirname(__file__), "data", "metrics_raw.csv")
FEATURES_PATH = os.path.join(os.path.dirname(__file__), "data", "features.csv")
STATS_PATH = os.path.join(os.path.dirname(__file__), "data", "normalization_stats.json")
SUMMARY_PATH = os.path.join(os.path.dirname(__file__), "data", "preprocess_summary.json")

MIN_SAMPLES_PER_SERVICE = load_config()["min_samples_per_service"]
FEATURE_COLUMNS = ["cpu_percent", "memory_percent", "network_rx_rate", "network_tx_rate"]


def compute_rates(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["service_id", "timestamp"]).copy()
    df["network_rx_rate"] = np.nan
    df["network_tx_rate"] = np.nan
    df["restarted"] = False

    for service_id, group in df.groupby("service_id"):
        idx = group.index
        rx = group["network_rx_bytes"].astype(float)
        tx = group["network_tx_bytes"].astype(float)
        t = group["timestamp"]
        dt = t.diff().dt.total_seconds()

        rx_delta = rx.diff()
        tx_delta = tx.diff()

        restarted = (rx_delta < 0) | (tx_delta < 0)
        rx_rate = (rx_delta / dt).where(~restarted, 0.0)
        tx_rate = (tx_delta / dt).where(~restarted, 0.0)

        df.loc[idx, "network_rx_rate"] = rx_rate.values
        df.loc[idx, "network_tx_rate"] = tx_rate.values
        df.loc[idx, "restarted"] = restarted.fillna(False).values

    return df


def main():
    if not os.path.exists(RAW_PATH):
        print(f"[preprocess] no raw data at {RAW_PATH} yet — run collector.py first", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(RAW_PATH)
    if df.empty:
        print("[preprocess] metrics_raw.csv is empty, nothing to do", file=sys.stderr)
        sys.exit(1)

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    before = len(df)
    df = df.dropna(subset=["timestamp", "service_id"])
    if len(df) < before:
        print(f"[preprocess] dropped {before - len(df)} rows with unparseable timestamp/service_id")

    df = compute_rates(df)

    # first sample of each service has no prior sample to diff against
    df = df.dropna(subset=["network_rx_rate", "network_tx_rate"])

    stats = {}
    normalized_frames = []
    skipped_services = []
    per_service_summary = {}

    for service_id, group in df.groupby("service_id"):
        if len(group) < MIN_SAMPLES_PER_SERVICE:
            skipped_services.append((service_id, len(group)))
            per_service_summary[service_id] = {"raw_samples": len(group), "feature_samples": 0, "status": "skipped_too_few_samples"}
            continue

        service_stats = {}
        norm = group.copy()
        nan_cols = []
        for col in FEATURE_COLUMNS:
            mean = float(group[col].mean())
            std = float(group[col].std(ddof=0))
            service_stats[col] = {"mean": mean, "std": std}
            if std > 0:
                norm[f"z_{col}"] = (group[col] - mean) / std
            else:
                # zero variance (e.g. a service that never moved) — z-score
                # is undefined, not "0 forever"; record it honestly as NaN
                norm[f"z_{col}"] = np.nan
                nan_cols.append(col)

        stats[service_id] = service_stats
        normalized_frames.append(norm)
        per_service_summary[service_id] = {
            "raw_samples": len(group),
            "feature_samples": len(group),
            "status": "ok",
            "zero_variance_features": nan_cols,
        }

    if skipped_services:
        print(f"[preprocess] skipped {len(skipped_services)} services with < {MIN_SAMPLES_PER_SERVICE} samples:")
        for sid, n in skipped_services:
            print(f"  {sid}: {n} samples")

    def write_summary(status, extra=None):
        summary = {
            "generated_at": pd.Timestamp.now('UTC').isoformat(),
            "status": status,
            "min_samples_per_service": MIN_SAMPLES_PER_SERVICE,
            "raw_rows_read": before,
            "per_service": per_service_summary,
        }
        if extra:
            summary.update(extra)
        tmp = SUMMARY_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(summary, f, indent=2)
        os.replace(tmp, SUMMARY_PATH)

    if not normalized_frames:
        write_summary("no_service_ready")
        print("[preprocess] no service had enough samples to produce features — collect more data first", file=sys.stderr)
        sys.exit(1)

    result = pd.concat(normalized_frames, ignore_index=True)
    result.to_csv(FEATURES_PATH, index=False)
    with open(STATS_PATH, "w") as f:
        json.dump(stats, f, indent=2)

    print(f"[preprocess] wrote {len(result)} feature rows across {len(stats)} services -> {FEATURES_PATH}")
    print(f"[preprocess] wrote normalization stats -> {STATS_PATH}")

    # basic quality signal, printed not silently dropped
    nan_counts = result[[f"z_{c}" for c in FEATURE_COLUMNS]].isna().sum()
    if nan_counts.sum() > 0:
        print(f"[preprocess] NaN z-scores (zero-variance features): {nan_counts.to_dict()}")

    write_summary("ok", {
        "feature_rows_written": len(result),
        "services_with_features": len(stats),
        "nan_zscore_counts": {k: int(v) for k, v in nan_counts.to_dict().items()},
    })


if __name__ == "__main__":
    main()

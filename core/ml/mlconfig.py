"""Shared, hot-reloadable config for the pipeline. The UI edits config.json
directly (via the Node app); long-running scripts (collector.py, score.py)
re-read it each cycle so a tweak takes effect within one cycle, no restart
needed. One-shot scripts (preprocess.py, train.py) read it once at startup.
"""

import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

ALL_FEATURE_COLUMNS = [
    "z_cpu_percent",
    "z_memory_percent",
    "z_network_rx_rate",
    "z_network_tx_rate",
]

DEFAULTS = {
    "collect_interval_sec": 10,
    "min_samples_per_service": 10,
    "min_training_samples": 30,
    "contamination": 0.01,
    "score_interval_sec": 10,
    "persistence_windows": 3,
    "n_estimators": 200,
    "max_samples_fraction": 1.0,
    # Chronological tail held out of training and scored afterwards. The
    # tail isn't labelled, so its flag rate is not an accuracy figure — it
    # only says how often the model fires on data it never saw. Compare it
    # to `contamination`: much higher means drift or a non-normal tail.
    "holdout_fraction": 0.2,
    "feature_columns": list(ALL_FEATURE_COLUMNS),
}


def load_config() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        return {**DEFAULTS, **cfg}
    except Exception:
        return dict(DEFAULTS)

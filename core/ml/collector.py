#!/usr/bin/env python3
"""
Polls the running microservice-mapper API and appends one row per service
per poll to an append-only CSV. Decoupled from the Node app on purpose: the
mapper's own MetricStore only keeps a rolling ~1h window in memory (720
samples), it's built for the live dashboard, not for accumulating a growing
training set. This is the actual growing dataset.

Never fabricates a value: if a field is missing from the API response, the
CSV cell is left empty rather than defaulted to 0.
"""

import csv
import os
import sys
import time
import urllib.request
import json
from datetime import datetime, timezone

from mlconfig import load_config

MAPPER_URL = os.environ.get("MAPPER_URL", "http://localhost:3001")
OUT_PATH = os.path.join(os.path.dirname(__file__), "data", "metrics_raw.csv")
SUMMARY_PATH = os.path.join(os.path.dirname(__file__), "data", "collection_summary.json")

COLUMNS = [
    "timestamp", "project", "service_id", "service_name", "type", "status",
    "cpu_percent", "memory_percent", "memory_bytes", "network_rx_bytes", "network_tx_bytes",
]


def fetch_graph():
    with urllib.request.urlopen(f"{MAPPER_URL}/api/graph", timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def ensure_file():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    if not os.path.exists(OUT_PATH):
        with open(OUT_PATH, "w", newline="") as f:
            csv.writer(f).writerow(COLUMNS)


def row_for(node, ts):
    m = node.get("metrics") or {}
    return [
        ts,
        node.get("project", ""),
        node.get("id", ""),
        node.get("name", ""),
        node.get("type", ""),
        node.get("status", ""),
        m.get("cpu", ""),
        m.get("memoryPercent", ""),
        m.get("memory", ""),
        m.get("networkRx", ""),
        m.get("networkTx", ""),
    ]


def write_summary(started_at, per_service_count, per_service_first_seen, last_write_ts, total_rows, consecutive_failures, last_error):
    summary = {
        "started_at": started_at,
        "last_write_at": last_write_ts,
        "total_rows": total_rows,
        "services_seen": len(per_service_count),
        "poll_interval_sec": load_config()["collect_interval_sec"],
        "consecutive_failures": consecutive_failures,
        "last_error": last_error,
        "per_service": {
            sid: {
                "samples": per_service_count[sid],
                "first_seen": per_service_first_seen[sid],
            }
            for sid in per_service_count
        },
    }
    tmp_path = SUMMARY_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(summary, f, indent=2)
    os.replace(tmp_path, SUMMARY_PATH)  # atomic — never a half-written file for the UI to read


def main():
    ensure_file()
    print(f"[collector] writing to {OUT_PATH}, polling {MAPPER_URL}", flush=True)
    started_at = datetime.now(timezone.utc).isoformat()
    consecutive_failures = 0
    last_error = None
    per_service_count: dict[str, int] = {}
    per_service_first_seen: dict[str, str] = {}
    total_rows = 0

    while True:
        ts = datetime.now(timezone.utc).isoformat()
        try:
            graph = fetch_graph()
            nodes = graph.get("nodes", [])
            with open(OUT_PATH, "a", newline="") as f:
                writer = csv.writer(f)
                for node in nodes:
                    if not node.get("metrics"):
                        continue  # no fabricated rows for nodes with no telemetry yet
                    writer.writerow(row_for(node, ts))
                    sid = node.get("id", "")
                    per_service_count[sid] = per_service_count.get(sid, 0) + 1
                    if sid not in per_service_first_seen:
                        per_service_first_seen[sid] = ts
                    total_rows += 1
            consecutive_failures = 0
            last_error = None
            print(f"[collector] {ts} wrote {len(nodes)} node rows", flush=True)
        except Exception as e:
            consecutive_failures += 1
            last_error = str(e)
            print(f"[collector] {ts} FAILED ({consecutive_failures}x): {e}", file=sys.stderr, flush=True)
            # never let a failed cycle look like a quiet/normal period — the
            # gap itself is visible in the CSV's timestamp jump
        write_summary(started_at, per_service_count, per_service_first_seen, ts, total_rows, consecutive_failures, last_error)
        poll_interval_sec = load_config()["collect_interval_sec"]  # re-read each cycle so a UI tweak applies live
        time.sleep(poll_interval_sec)


if __name__ == "__main__":
    main()

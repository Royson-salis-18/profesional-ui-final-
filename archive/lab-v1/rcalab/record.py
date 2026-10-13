"""Record one labelled run: read telemetry for a window from the observability APIs.

The fault itself is injected OUTSIDE this app (e.g. the OTel demo's feature-flag UI). The app only
reads telemetry and stores the label you report; the label is used solely by `evaluate`.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from . import store
from .collect import collect


def _ts(s: str) -> float:
    return float(s) if s.replace(".", "", 1).isdigit() else datetime.fromisoformat(s).timestamp()


def record(cfg: dict, service: str, fault: str, start: str, end: str, out_dir: Path) -> Path:
    t_inject, t_recover = _ts(start), _ts(end)
    step = cfg["collection"]["step_seconds"]
    base_s = cfg["collection"]["baseline_minutes"] * 60
    out_dir.mkdir(parents=True, exist_ok=True)
    tel = collect(cfg, t_inject - base_s, t_recover + 3 * step)
    store.save(out_dir / "telemetry.npz", tel)
    (out_dir / "label.json").write_text(json.dumps({
        "service": service, "fault": fault, "t_inject": t_inject, "t_recover": t_recover,
        "baseline_windows": int(base_s // step)}, indent=2))
    return out_dir

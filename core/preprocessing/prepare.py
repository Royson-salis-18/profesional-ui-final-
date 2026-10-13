"""Data preprocessing: raw telemetry rows -> the cube X[tick, service, feature] the algorithms work on.

* cumulative counters (network, disk) become per-second rates; a counter that goes down (restart) becomes unknown, not a spike;
* the first row after any collection gap is dropped (no rate yet, and its log scan holds the whole backlog);
* container_up: a container that disappears while the others are still reported becomes 0 (crashed or stopped). Without this
  a crash looks like "no data" instead of "broken";
* wiring names ("orders") are matched to data names ("orders-1", "socialnetwork-orders-1").

No scoring happens here. Derived from the research notebook (colab/rca_research_src.py, section 2), the same code the report measured;
core/tests guard the report's numbers. The one addition is `down_ticks`: how long a vanished container keeps reading container_up = 0.
The default (6 ticks) is what the bench and the real-crash replay were measured with; live analysis passes a long value, because a
container that stays stopped must keep its incident open instead of fading after a minute.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .spec import CUMULATIVE, SPEC

@dataclass
class Panel:
    times: np.ndarray          # (T,) seconds
    services: list
    features: list
    X: np.ndarray              # (T, S, F); NaN = unknown
    edges: list = field(default_factory=list)   # (caller, callee)
    step: float = 15.0

def match_edges(raw, services):
    """Map wiring names ('orders') onto data names ('orders-1', 'socialnetwork-orders-1')."""
    import re
    out = set()
    pick = lambda a: ([s for s in services if s == a or re.search(r"(^|[-_])" + re.escape(a) + r"([-_]\d+)?$", s)] or [s for s in services if a in s])[:1]
    for a, b in raw:
        for x in pick(a):
            for y in pick(b):
                if x != y:
                    out.add((x, y))
    return sorted(out)

def prepare(df, step=None, track_presence=True, gap_factor=5.0, drop_first=True, edges=None, down_ticks=6):
    d = df.copy(); d["timestamp"] = pd.to_datetime(d["timestamp"], utc=True)
    feats = [c for c in SPEC if c in d.columns and c != "container_up"]
    parts = []
    for svc, g in d.sort_values("timestamp").groupby("service", sort=False):
        t = g["timestamp"].astype("int64").to_numpy() / 1e9
        dt = np.diff(t, prepend=np.nan)
        med = np.nanmedian(dt[1:]) if len(dt) > 2 else 30.0
        new_session = np.isnan(dt) | (dt > gap_factor * med)          # first row, or first row after a collector gap
        row = pd.DataFrame({"t": t, "service": svc})
        for f in feats:
            v = pd.to_numeric(g[f], errors="coerce").to_numpy(float)
            if f in CUMULATIVE:                                       # counter -> per-second rate
                dv = np.diff(v, prepend=np.nan)
                v = dv / np.where(dt > 0, dt, np.nan)
                v[new_session | (dv < 0)] = np.nan                    # restart / reset: unknown, not a spike
            row[f] = v
        if drop_first:
            row.loc[new_session, feats] = np.nan
        if "network_rx_bytes" in feats and "network_tx_bytes" in feats:
            row["activity"] = row["network_rx_bytes"] + row["network_tx_bytes"]
        parts.append(row)
    long = pd.concat(parts, ignore_index=True)
    if "activity" in long.columns:
        feats = feats + ["activity"]
    if step is None:
        step = float(max(5, round(np.nanmedian([np.nanmedian(np.diff(p["t"])) for p in parts if len(p) > 2]))))
    long["tick"] = np.floor(long["t"] / step).astype(np.int64)
    ticks = np.sort(long["tick"].unique()); tmap = {k: i for i, k in enumerate(ticks)}
    services = list(dict.fromkeys(long["service"])); smap = {s: i for i, s in enumerate(services)}
    F = feats + (["container_up"] if track_presence else [])
    X = np.full((len(ticks), len(services), len(F)), np.nan)
    present = np.zeros((len(ticks), len(services)), bool)
    for tick, svc, *vals in long[["tick", "service"] + feats].itertuples(index=False, name=None):
        X[tmap[tick], smap[svc], :len(feats)] = vals; present[tmap[tick], smap[svc]] = True
    if track_presence:                                                # vanished while the others still report = down
        k = F.index("container_up")
        for j in range(len(services)):
            last = -10 ** 9
            for i in range(len(ticks)):
                if present[i, j]:
                    last = i; X[i, j, k] = 1.0
                elif i - last <= down_ticks and present[i].any():
                    X[i, j, k] = 0.0
    return Panel(ticks.astype(float) * step, services, F, X, match_edges(edges, services) if edges else [], step)

def panel_from_otel(o):
    """The OTel file is already a cube; keep the trace features and add container_up = 1 (all services running)."""
    keep = ["latency_p95", "trace_errors", "span_rate", "self_latency"]
    X = np.stack([o["X"][:, :, o["features"].index(f)] for f in keep] + [np.ones(o["X"].shape[:2])], axis=2)
    return Panel(np.asarray(o["times"], float), list(o["services"]), keep + ["container_up"], X, list(o["edges"]), float(np.median(np.diff(o["times"]))))

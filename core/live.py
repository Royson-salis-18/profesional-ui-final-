"""Live data: poll the graph service, keep a time series per target, and run the algorithms on it.

The graph service (server/, port 3001) already holds every container's CPU, memory and network counters and an evidence-tagged
dependency graph, collected over SSH. This module reads that through `GET /api/graph` instead of opening a second set of SSH
connections: one reading per poll, kept as rows {t, svc: {name: {cpu, mem, rx, tx}}}, then handed to core.preprocessing.prepare.

A container that stops being reported while its neighbours still are becomes container_up = 0 (that is how a crash is seen).
A poll in which NO node of a target is fresh is skipped entirely: that is "no data", not "everything crashed".
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from .algo import alarm_window, attribute, edges_from_graph, live_threshold, risk, score
from .preprocessing import prepare

NODE_URL = os.environ.get("CORE_NODE_URL", "http://localhost:3001")
DATA_DIR = Path(os.environ.get("CORE_DATA_DIR", Path(__file__).resolve().parent / "data" / "live"))
STEP = int(os.environ.get("CORE_STEP", 10))        # seconds per tick, as in the notebook's live analysis (CORE_STEP shortens it for tests)
KEEP_S = 3 * 3600               # history kept per target


def _age_s(iso: str | None, now: float) -> float:
    try:
        return now - datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except Exception:
        return float("inf")


def fetch_graph(url: str = NODE_URL, timeout: float = 8.0) -> dict:
    with urllib.request.urlopen(f"{url}/api/graph", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


@dataclass
class Analysis:
    target: str
    panel: object
    scores: object
    tau: float
    flags: np.ndarray
    window: tuple | None
    attribution: pd.DataFrame | None
    at_risk: pd.Series
    t: int                                  # index of the newest tick
    ids: dict                               # service name -> graph node id


class LiveCollector:
    """Keeps recent samples per target; thread-safe. `poll()` reads the graph service once; `start()` polls forever."""

    def __init__(self, node_url: str = NODE_URL, step: int = STEP, persist: bool = True):
        self.node_url, self.step, self.persist = node_url, step, persist
        self.rows: dict[str, deque] = defaultdict(deque)
        self.edges: dict[str, list] = {}
        self.ids: dict[str, dict] = defaultdict(dict)
        self.status: dict = {"last_poll": None, "error": None}
        self._lock = threading.Lock()
        self._halt = threading.Event()
        if persist:
            self._load()

    # ------------------------------------------------------------------ collection
    def poll(self, graph: dict | None = None, now: float | None = None) -> int:
        """One reading. Returns how many rows were stored (one per target that had fresh data)."""
        g = graph if graph is not None else fetch_graph(self.node_url)
        now = now if now is not None else time.time()
        fresh_s = float(os.environ.get("CORE_FRESH_S", max(45.0, 4.0 * self.step)))   # a node not touched for this long counts as not reported
        by_target: dict[str, dict] = defaultdict(dict)
        for n in g.get("nodes", []):
            m = n.get("metrics") or {}
            tgt = n.get("project") or str(n.get("id", "")).split(":")[0]
            self.ids[tgt][n.get("name", n["id"])] = n["id"]
            if _age_s(n.get("lastSeen"), now) > fresh_s or (n.get("metadata") or {}).get("state") not in (None, "running"):
                continue                                         # not reported this cycle: absent from the row, so it can read as down
            if m.get("cpu") is None and m.get("networkRx") is None:
                continue
            by_target[tgt][n.get("name", n["id"])] = {"cpu": m.get("cpu"), "mem": m.get("memory"), "rx": m.get("networkRx"), "tx": m.get("networkTx")}
        stored = 0
        with self._lock:
            for tgt, svc in by_target.items():
                row = {"t": now, "svc": svc}
                q = self.rows[tgt]
                q.append(row)
                while q and q[0]["t"] < now - KEEP_S:
                    q.popleft()
                stored += 1
                if self.persist:
                    DATA_DIR.mkdir(parents=True, exist_ok=True)
                    with open(DATA_DIR / f"{tgt}.jsonl", "a", encoding="utf-8") as f:
                        f.write(json.dumps(row) + "\n")
            for tgt in {n.get("project") or str(n.get("id", "")).split(":")[0] for n in g.get("nodes", [])}:
                mine = {"nodes": [n for n in g.get("nodes", []) if (n.get("project") or str(n.get("id", "")).split(":")[0]) == tgt],
                        "edges": [e for e in g.get("edges", []) if str(e.get("source", "")).startswith(tgt + ":")]}
                self.edges[tgt] = edges_from_graph(mine)
        self.status.update(last_poll=now, error=None)
        return stored

    def start(self):
        def loop():
            while not self._halt.is_set():
                t0 = time.time()
                try:
                    self.poll()
                except Exception as e:                           # the graph service may be starting or restarting; keep trying
                    self.status["error"] = str(e)[:160]
                self._halt.wait(max(1.0, self.step - (time.time() - t0)))
        threading.Thread(target=loop, daemon=True, name="core-live-collector").start()
        return self

    def stop(self):
        self._halt.set()

    def _load(self):
        cutoff = time.time() - KEEP_S
        if not DATA_DIR.exists():
            return
        for f in DATA_DIR.glob("*.jsonl"):
            q = self.rows[f.stem]
            for line in f.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r["t"] >= cutoff:
                    q.append(r)

    # ------------------------------------------------------------------ analysis
    def targets(self) -> list[str]:
        return sorted(self.rows)

    def frame(self, target: str) -> pd.DataFrame:
        with self._lock:
            rows = list(self.rows.get(target, []))
        recs = [dict(timestamp=pd.Timestamp(r["t"], unit="s", tz="UTC"), service=n, cpu_percent=v.get("cpu"),
                     memory_usage_mb=None if v.get("mem") is None else v["mem"] / 1e6,
                     network_rx_bytes=v.get("rx"), network_tx_bytes=v.get("tx")) for r in rows for n, v in r["svc"].items()]
        return pd.DataFrame(recs)

    def analyse(self, target: str, window: int = 60, min_base: int = 12, silence_k: int = 6) -> Analysis | None:
        """Prepare, score and threshold a target's history; rank the alarm that is active now, if any. None until there is enough data."""
        df = self.frame(target)
        if df.empty or df.timestamp.nunique() < min_base + 4:
            return None
        p = prepare(df, step=self.step, track_presence=True, edges=self.edges.get(target) or None, down_ticks=int(KEEP_S // self.step))
        sc = score(p, window=window, min_base=min_base, silence_k=silence_k)
        scn, tau, fl = live_threshold(sc, p.step)
        t = len(p.times) - 1
        win = alarm_window(fl, t)
        att = attribute(p, scn, win) if win else None
        rk = risk(p, scn, fl, t, tau) if p.edges else pd.Series(dtype=float)
        return Analysis(target, p, scn, tau, fl, win, att, rk, t, dict(self.ids.get(target, {})))

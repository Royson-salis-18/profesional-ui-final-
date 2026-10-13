"""The test bench: labelled faults injected into real healthy traffic, and how each method scores on them.

77 minutes of real OpenTelemetry-demo traffic (core/data/otel_healthy_long.npz) is played forwards and backwards into a
10-hour stretch; faults (slow, errors, crash, hang) are injected at random times on random services. Every injection goes in a
ledger, which is the answer key. The method never sees it; it is only used to mark the method's ranking right or wrong.

Verbatim from colab/rca_research_src.py, section 8. Seeds 0-2 were used while developing the method; 3-22 are the judging seeds.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

from ..algo import (attribute, calibrate, callers_of, episodes_per_hour, flags_for, normalise, score)
from ..preprocessing import Panel, panel_from_otel

display = print
DATA = Path(__file__).resolve().parent.parent / "data"


class _LazyOtel:
    """The healthy OTel traffic the bench is built from, loaded on first use."""
    _d = None

    def __getitem__(self, k):
        if self._d is None:
            zf = np.load(DATA / "otel_healthy_long.npz", allow_pickle=True)
            meta = json.loads(str(zf["meta"]))
            type(self)._d = dict(times=zf["times"], X=zf["X"], services=meta["services"], features=meta["features"],
                                 edges=[tuple(e) for e in meta["edges"]])
        return self._d[k]


OTEL = _LazyOtel()

def make_bench(seed=0, tiles=8, gap=(40, 60), dur=(8, 16), kinds=("slow", "errors", "crash", "hang")):
    rng = np.random.default_rng(seed)
    base = panel_from_otel(OTEL)
    X = np.concatenate([base.X if i % 2 == 0 else base.X[::-1] for i in range(tiles)])
    T = X.shape[0]; times = base.times[0] + np.arange(T) * base.step
    clean = Panel(times, base.services, base.features, X.copy(), base.edges, base.step)
    fi = {f: i for i, f in enumerate(base.features)}
    valid = np.mean(~np.isnan(base.X[:, :, fi["latency_p95"]]), axis=0)
    eligible = [i for i in range(len(base.services)) if valid[i] >= 0.4]
    up = callers_of(base.edges); sidx = {s: i for i, s in enumerate(base.services)}
    ledger, t = [], 160
    while t + 20 < T:
        r = int(rng.choice(eligible)); kind = str(rng.choice(kinds)); d = int(rng.integers(*dur)); a, b = t, t + d
        hop1 = [sidx[c] for c in up.get(base.services[r], [])]
        hop2 = [sidx[c2] for c in hop1 for c2 in up.get(base.services[c], [])]
        seg = X[a:b]
        if kind == "slow":
            m = rng.uniform(2, 5)
            seg[:, r, fi["latency_p95"]] *= m; seg[:, r, fi["self_latency"]] *= m
            for hop, hs in ((1, hop1), (2, hop2)):
                for c in hs:
                    if rng.random() < .8: seg[:, c, fi["latency_p95"]] *= 1 + (m - 1) * .7 ** hop
        elif kind == "errors":
            e = rng.uniform(.2, .6)
            seg[:, r, fi["trace_errors"]] = np.where(np.isnan(seg[:, r, fi["trace_errors"]]), np.nan, np.maximum(seg[:, r, fi["trace_errors"]], e))
            for hop, hs in ((1, hop1), (2, hop2)):
                for c in hs:
                    v = seg[:, c, fi["trace_errors"]]; seg[:, c, fi["trace_errors"]] = np.where(np.isnan(v), np.nan, np.maximum(v, e * .6 ** hop))
        elif kind in ("crash", "hang"):
            for f in ("latency_p95", "trace_errors", "span_rate", "self_latency"):
                seg[:, r, fi[f]] = np.nan
            if kind == "crash":
                seg[:, r, fi["container_up"]] = 0.0
            e = rng.uniform(.3, .9) if kind == "crash" else rng.uniform(.1, .4)
            lm = 1.5 if kind == "crash" else rng.uniform(3, 8)
            for hop, hs in ((1, hop1), (2, hop2)):
                for c in hs:
                    v = seg[:, c, fi["trace_errors"]]; seg[:, c, fi["trace_errors"]] = np.where(np.isnan(v), np.nan, np.maximum(v, e * .5 ** (hop - 1)))
                    seg[:, c, fi["latency_p95"]] *= 1 + (lm - 1) * .5 ** (hop - 1)
        ledger.append({"root": base.services[r], "kind": kind, "a": a, "b": b})
        t = b + int(rng.integers(*gap))
    return clean, Panel(times, base.services, base.features, X, base.edges, base.step), ledger

def original_method(p, a=None, b=None):
    """The original notebook: per service/feature z over the WHOLE dataset (mean/std, raw scale), anomaly = |z| > 3."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        Zw = np.abs((p.X - np.nanmean(p.X, axis=0)) / np.nanstd(p.X, axis=0))
    return np.nan_to_num(np.nanmax(np.where(np.isnan(Zw), -1, Zw), axis=2), nan=0) > 3

def rank_window(method, p, sc, fl, a, b, cfg, rng):
    if method == "ours":
        return list(attribute(p, sc, (a, b), cfg["gamma"], cfg["hard"], cfg["infer"], cfg["agg"], cfg["explain"]).service)
    if method == "most_abnormal":
        return [p.services[i] for i in np.argsort(-sc.zs[a:b].max(axis=0))]
    if method == "earliest":
        first = np.where(fl[a:b].any(axis=0), np.argmax(fl[a:b], axis=0), 10 ** 6)
        return [p.services[i] for i in np.lexsort((-sc.zs[a:b].max(axis=0), first))]
    if method == "random":
        return list(rng.permutation(p.services))
    if method == "original":
        return [p.services[i] for i in np.argsort(-fl[a:b].sum(axis=0), kind="stable")]

DEFAULT = dict(window=60, min_base=12, persistence=2, budget=2.0, common_frac=0.5, gamma=1.0, hard=True, infer=True,
               log_scale=True, self_heal=True, tail_q=0.9, binomial=True, per_series=True, smooth=1, agg="max", win_k=0, silence_k=6, explain="all", method="ours", seed=0)
_BENCH, _SCORES = {}, {}

def run(cfg=None, verbose=False, **over):
    cfg = {**DEFAULT, **(cfg or {}), **over}
    if cfg["seed"] not in _BENCH:
        _BENCH[cfg["seed"]] = make_bench(cfg["seed"])
    clean, p, ledger = _BENCH[cfg["seed"]]
    rng = np.random.default_rng(cfg["seed"])
    kw = dict(window=cfg["window"], min_base=cfg["min_base"], common_frac=cfg["common_frac"], log_scale=cfg["log_scale"], self_heal=cfg["self_heal"], tail_q=cfg["tail_q"], binomial=cfg["binomial"], smooth=cfg["smooth"], win_k=cfg["win_k"], silence_k=cfg["silence_k"])
    key = (cfg["seed"], tuple(sorted(kw.items())))
    if key not in _SCORES:
        _SCORES[key] = (score(p, **kw), score(clean, **kw))
    sc, sc_clean = _SCORES[key]
    if cfg["per_series"]:
        sc, sc_clean = normalise(sc, sc_clean), normalise(sc_clean, sc_clean)
    if cfg["method"] == "original":
        fl = original_method(p); tau = float("nan")
    else:
        tau = calibrate(sc_clean, p.step, cfg["budget"], cfg["persistence"])   # threshold from healthy history only
        fl = flags_for(sc, tau, cfg["persistence"])
    rows, healthy = [], np.ones(len(p.times), bool)
    for f in ledger:
        a, b = f["a"], f["b"] + 4; healthy[max(f["a"] - 2, 0):b + 4] = False
        j = p.services.index(f["root"])
        hit = fl[a:b, j].any()
        order = rank_window(cfg["method"], p, sc, fl, f["a"], b, cfg, rng)
        rk = order.index(f["root"]) + 1
        rows.append(dict(kind=f["kind"], root=f["root"], recall=hit, any_flag=fl[a:b].any(), delay_s=(np.argmax(fl[a:b, j]) * p.step) if hit else np.nan,
                         rank=rk, A1=rk == 1, A3=rk <= 3))
    R = pd.DataFrame(rows)
    fa = episodes_per_hour(fl[healthy], p.step)
    summary = dict(tau=tau, faults=len(R), recall=R.recall.mean(), A1=R.A1.mean(), A3=R.A3.mean(), delay_s=R.delay_s.mean(), false_alarms_h=fa,
                   **{f"A1_{k}": g.A1.mean() for k, g in R.groupby("kind")}, **{f"recall_{k}": g.recall.mean() for k, g in R.groupby("kind")})
    if verbose:
        display(R.groupby("kind")[["recall", "A1", "A3", "delay_s"]].mean().round(2))
    return summary, R

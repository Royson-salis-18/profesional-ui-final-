# ARCHIVED COPY. The maintained algorithms live in /core/algo.py (pure algorithms) and /core/preprocessing/ (data preparation).
# This file is only here so the archived lab-v1 server still runs; do not edit it.
"""The research method behind RCA_STATISTICAL_REPORT (its core/ folder), for the lab.

Everything between the two banner lines is copied VERBATIM from colab/rca_research_src.py, the notebook that is the source of
truth (same functions, same defaults, same bench), so the lab runs exactly the method the report measured. Only plotting and
notebook glue are left out. If you change the method, change it in the notebook and re-run tools/sync_core.py-style extraction,
or edit both. The lab glue (adapting live Telemetry, caching the bench) is at the bottom and is not part of the method.
"""
from __future__ import annotations

import json
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
display = print                                   # the notebook's IPython display, only used by run(verbose=True)


class _LazyOtel:
    """The 77 healthy OTel minutes the bench is built from (docs/experiments/otel_healthy_long.npz), loaded on first use."""
    _d = None

    def __getitem__(self, k):
        if self._d is None:
            zf = np.load(ROOT / "docs/experiments/otel_healthy_long.npz", allow_pickle=True)
            meta = json.loads(str(zf["meta"]))
            type(self)._d = dict(times=zf["times"], X=zf["X"], services=meta["services"], features=meta["features"],
                                 edges=[tuple(e) for e in meta["edges"]])
        return self._d[k]


OTEL = _LazyOtel()

# ======================================== verbatim from colab/rca_research_src.py ========================================
SPEC = {   # feature: (direction that means trouble, scale, evidence group)
    "cpu_percent": (+1, "log", "own"), "memory_usage_mb": (+1, "log", "own"), "pids": (+1, "log", "sym"),  # threads pile up in a service WAITING on a slow callee: inheritable
    "block_read_bytes": (+1, "log", "own"), "block_write_bytes": (+1, "log", "own"),
    "network_rx_bytes": (+1, "log", "sym"), "network_tx_bytes": (+1, "log", "sym"),
    "log_count": (+1, "log", "sym"), "error_count": (+1, "log", "sym"), "warning_count": (+1, "log", "sym"),
    "latency_p95": (+1, "log", "sym"), "trace_errors": (+1, "lin", "sym"), "span_rate": (-1, "log", "sym"),
    "self_latency": (+1, "log", "own"), "container_up": (-1, "lin", "own"),
    "silence": (+1, "lin", "own"),
    "activity": (-1, "log", "aux"),  # network in+out rate (SSH data): only an input to "alive?" in silence (its kB-quantised
                                     # counters make it too noisy to score on its own)   # computed in score(): a normally chatty service that went quiet
}
# "own"  = evidence about the service ITSELF (its CPU, memory, its own processing time, whether it is running)
# "sym"  = symptoms that can be INHERITED from a broken dependency (errors, end-to-end latency, traffic, log errors)
CUMULATIVE = {"network_rx_bytes", "network_tx_bytes", "block_read_bytes", "block_write_bytes"}
FLOOR = {"log": 0.15, "lin": 0.05}
# the smallest change worth noticing, per feature: log(x + UNIT) instead of log(1 + x), so a series that is usually 0 cannot
# score z = 46 for one quantised kB tick (docker stats prints network bytes in kB steps)
UNIT = {"network_rx_bytes": 2000.0, "network_tx_bytes": 2000.0, "activity": 2000.0, "block_read_bytes": 4096.0,
        "block_write_bytes": 4096.0, "cpu_percent": 0.5, "memory_usage_mb": 1.0}    # smallest allowed spread: a 15% change (log scale) or 0.05 absolute (0..1 quantities)

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

def prepare(df, step=None, track_presence=True, gap_factor=5.0, drop_first=True, edges=None):
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
                elif i - last <= 6 and present[i].any():
                    X[i, j, k] = 0.0
    return Panel(ticks.astype(float) * step, services, F, X, match_edges(edges, services) if edges else [], step)

def panel_from_otel(o):
    """The OTel file is already a cube; keep the trace features and add container_up = 1 (all services running)."""
    keep = ["latency_p95", "trace_errors", "span_rate", "self_latency"]
    X = np.stack([o["X"][:, :, o["features"].index(f)] for f in keep] + [np.ones(o["X"].shape[:2])], axis=2)
    return Panel(np.asarray(o["times"], float), list(o["services"]), keep + ["container_up"], X, list(o["edges"]), float(np.median(np.diff(o["times"]))))

@dataclass
class Scores:
    z: np.ndarray        # (T,S,F) one-sided deviations (0 = normal or not judged)
    med: np.ndarray      # (T,S,F) baseline median used at each tick (transformed scale)
    scale: np.ndarray    # (T,S,F) baseline spread used at each tick
    own: np.ndarray      # (T,S) max over "own" features
    sym: np.ndarray      # (T,S) max over "symptom" features
    zs: np.ndarray       # (T,S) max(own, sym) = the service's anomaly score
    judged: np.ndarray   # (T,S) at least one feature could be judged
    common: np.ndarray   # (T,F) share of services moving together (before removal)
    features: list = None  # names of the columns of z (p.features, plus "silence" if computed)

def sorted_q(A, n, q):
    """q-quantile along axis 0 of an array already sorted along axis 0 (NaN sort last); n = valid count per column."""
    idx = np.clip(np.floor(q * (np.maximum(n, 1) - 1)).astype(int), 0, A.shape[0] - 1)
    out = np.take_along_axis(A, idx[None], axis=0)[0]
    return np.where(n > 0, out, np.nan)

def score(p, window=60, min_base=12, guard=2, exclude_z=4.0, common_frac=0.5, log_scale=True, self_heal=True, tail_q=0.9, binomial=True, smooth=1, win_k=0, silence_k=0):
    T, S, F = p.X.shape
    X = p.X.copy()
    direction = np.array([SPEC[f][0] for f in p.features], float)
    floor = np.array([FLOOR[SPEC[f][1]] for f in p.features], float)
    for j, f in enumerate(p.features):
        if log_scale and SPEC[f][1] == "log":
            X[:, :, j] = np.log(np.maximum(X[:, :, j], 0) + UNIT.get(f, 1.0))
        elif not log_scale and SPEC[f][1] == "log":
            floor[j] = 1e-6
    if smooth > 1:                                                      # rolling median of the last `smooth` VALID values per series:
        Xs = X.copy()                                                   # a sustained shift survives, a one-tick spike does not
        for j in range(F):
            if p.features[j] == "container_up":
                continue
            df_ = pd.DataFrame(X[:, :, j])
            Xs[:, :, j] = np.where(np.isnan(X[:, :, j]), np.nan, df_.rolling(smooth, min_periods=1).median().to_numpy())
        X = Xs
    k_err = p.features.index("trace_errors") if "trace_errors" in p.features else None
    k_rate = p.features.index("span_rate") if "span_rate" in p.features else None
    Z = np.zeros((T, S, F)); MED = np.full((T, S, F), np.nan); SC = np.full((T, S, F), np.nan)
    J = np.zeros((T, S, F), bool)
    usable = ~np.isnan(X)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for t in range(T):
            lo, hi = max(0, t - window - guard), max(0, t - guard)
            if hi - lo < 5:
                continue
            B = np.where(usable[lo:hi], X[lo:hi], np.nan)              # only past samples that were normal
            n = np.sum(~np.isnan(B), axis=0)
            med = sorted_q(np.sort(B, axis=0), n, 0.5)                  # median of the baseline (NaN-aware, one sort)
            dev = np.sort(np.abs(B - med), axis=0)
            spread = np.maximum(sorted_q(dev, n, 0.5) * 1.4826, floor)  # 1.4826 x MAD = std for normal data
            if tail_q:                                                  # heavy tails / mostly-zero series: MAD collapses, so also
                spread = np.maximum(spread, sorted_q(dev, n, tail_q) / 1.645)   # respect the 90% deviation
            if binomial and k_err is not None and k_rate is not None:  # error RATE: 1 error in 4 requests is weak evidence
                p0 = np.clip(med[:, k_err], 0.01, 0.99); n_now = np.maximum(p.X[t, :, k_rate], 1)
                spread[:, k_err] = np.maximum(spread[:, k_err], np.sqrt(p0 * (1 - p0) / n_now))
            z = direction * (X[t] - med) / spread
            ok = (n >= min_base) & ~np.isnan(z)                         # enough history and a value now
            Z[t] = np.where(ok, np.clip(z, 0, 50), 0.0); J[t] = ok; MED[t] = med; SC[t] = spread
            if self_heal:
                usable[t] &= ~(Z[t] >= exclude_z)                       # an anomaly never becomes the baseline
    if win_k > 1:                                                       # WINDOW EVIDENCE: median of the last win_k ticks, judged with
        for j in range(F):                                              # the spread of a median of n values (spread x 1.25 / sqrt(n)):
            if p.features[j] == "container_up":                        # a sustained shift adds up, a one-tick spike does not
                continue
            D = pd.DataFrame(X[:, :, j])
            xm = D.rolling(win_k, min_periods=max(2, win_k // 2)).median().to_numpy()
            nv = D.notna().rolling(win_k, min_periods=1).sum().to_numpy()
            zw = direction[j] * (xm - MED[:, :, j]) / (SC[:, :, j] * 1.25 / np.sqrt(np.maximum(nv, 1)))
            okw = J.any(axis=2) & ~np.isnan(zw) & ~np.isnan(MED[:, :, j])
            Z[:, :, j] = np.where(okw, np.maximum(Z[:, :, j], np.clip(zw, 0, 50)), Z[:, :, j])
            J[:, :, j] |= okw
    feats = list(p.features)
    if silence_k > 0:                                                   # SILENCE: share of ticks with any symptom data, recent vs usual
        sym_cols = [j for j, f in enumerate(p.features) if SPEC[f][2] == "sym"]
        act = (~np.isnan(p.X[:, :, sym_cols])).any(axis=2) if sym_cols else np.zeros((T, S), bool)
        if "cpu_percent" in p.features:                                 # SSH/docker data: a row is always there (a paused container
            cpu_ = np.nan_to_num(p.X[:, :, p.features.index("cpu_percent")])   # is still listed), so "alive" = it used CPU or
            net_ = np.nan_to_num(p.X[:, :, p.features.index("activity")]) if "activity" in p.features else np.zeros((T, S))
            act = act & ((cpu_ > 0) | (net_ > 0))                       # moved bytes in this tick; frozen = exactly 0 and 0
        act = act.astype(float)
        A = pd.DataFrame(act)
        q = A.shift(guard + silence_k).rolling(window, min_periods=min_base).mean().to_numpy()   # usual activity rate
        obs = A.rolling(silence_k, min_periods=silence_k).sum().to_numpy()                      # recent activity count
        exp_ = silence_k * q
        zs_ = (exp_ - obs) / np.sqrt(np.maximum(exp_ * (1 - q), 1e-6))
        oks = ~np.isnan(zs_) & (exp_ >= 2.0)                            # only for services that usually report
        Zs = np.where(oks, np.clip(zs_, 0, 50), 0.0)
        Z = np.concatenate([Z, Zs[:, :, None]], axis=2); J = np.concatenate([J, oks[:, :, None]], axis=2)
        MED = np.concatenate([MED, np.full((T, S, 1), np.nan)], axis=2); SC = np.concatenate([SC, np.full((T, S, 1), np.nan)], axis=2)
        feats.append("silence")
    common = np.zeros((T, len(feats)))
    for j, f in enumerate(feats):                                       # STEP 4 lives here: common-mode removal
        for t in range(T):
            col, ok = Z[t, :, j], J[t, :, j]
            if ok.sum() >= 4:
                common[t, j] = np.mean(col[ok] > 3.0)
                if common_frac is not None and SPEC[f][2] == "sym" and common[t, j] > common_frac:
                    Z[t, :, j] = np.where(ok, np.maximum(col - np.median(col[ok]), 0.0), 0.0)
    own_i = [i for i, f in enumerate(feats) if SPEC[f][2] == "own"]
    sym_i = [i for i, f in enumerate(feats) if SPEC[f][2] == "sym"]
    own = Z[:, :, own_i].max(axis=2) if own_i else np.zeros((T, S))
    sym = Z[:, :, sym_i].max(axis=2) if sym_i else np.zeros((T, S))
    return Scores(Z, MED, SC, own, sym, np.maximum(own, sym), J.any(axis=2), common, feats)

def persist(raw, judged, k):
    if k <= 1:
        return raw.copy()
    run = np.zeros(raw.shape, int)
    for t in range(raw.shape[0]):
        prev = run[t - 1] if t else 0
        run[t] = np.where(raw[t], prev + 1, np.where(judged[t], 0, prev))   # unknown ticks keep the streak
    fl = run >= k
    for t in range(raw.shape[0] - 2, -1, -1):
        fl[t] |= raw[t] & fl[t + 1]                                            # mark the whole streak, not only its end
    return fl

def flags_for(sc, tau, persistence=2):
    return persist(sc.zs >= tau, sc.judged, persistence)

def episodes_per_hour(fl, step):
    starts = (fl[1:] & ~fl[:-1]).sum() + fl[0].sum()
    return starts / max(fl.shape[0] * step / 3600, 1e-9)

def normalise(sc, ref, q=0.995, features=None):
    """Per-series noise normalisation: a series that is jumpy even when HEALTHY (ref = scores on healthy history) is shrunk so its
    healthy extreme sits at z = 3; quiet series are never amplified. Then one global tau is fair to every service."""
    Zr = np.where(ref.z > 0, ref.z, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        Q = np.nan_to_num(np.nanquantile(Zr, q, axis=0), nan=0.0)          # (S, F) healthy extreme per series
    Z = sc.z / np.maximum(Q / 3.0, 1.0)
    fs = sc.features or features
    own_i = [i for i, f in enumerate(fs) if SPEC[f][2] == "own"]; sym_i = [i for i, f in enumerate(fs) if SPEC[f][2] == "sym"]
    own = Z[:, :, own_i].max(axis=2); sym = Z[:, :, sym_i].max(axis=2)
    return Scores(Z, sc.med, sc.scale, own, sym, np.maximum(own, sym), sc.judged, sc.common, fs)

def calibrate(sc, step, budget=2.0, persistence=2, grid=np.arange(1.5, 40.0, 0.25)):
    for tau in grid:
        if episodes_per_hour(flags_for(sc, tau, persistence), step) <= budget:
            return float(tau)
    return 40.0

def attribute(p, sc, window, gamma=1.0, hard=True, infer=True, agg="max", explain="all"):
    a, b = window
    if agg == "max":                                    # strongest single tick in the window
        own = sc.own[a:b].max(axis=0); sym = sc.sym[a:b].max(axis=0)
    else:                                               # "sustained": mean of the top half of ticks (one spike cannot win)
        def top_half(M):
            k = max(1, (b - a) // 2)
            return np.sort(M[a:b], axis=0)[-k:].mean(axis=0)
        own = top_half(sc.own); sym = top_half(sc.sym)
    idx = {s: i for i, s in enumerate(p.services)}
    callees, callers = {}, {}
    for c, e in p.edges:
        if c in idx and e in idx:
            callees.setdefault(idx[c], []).append(idx[e]); callers.setdefault(idx[e], []).append(idx[c])
    fs = sc.features or p.features
    own_raw = own.copy()
    soft_cols = [k for k, f in enumerate(fs) if f in ("silence", "activity")]               # quiet signals that CAN be inherited
    quiet_cols = soft_cols + [k for k, f in enumerate(fs) if f == "container_up"]          # what makes a caller "quiet or down"
    if soft_cols:                                       # QUIET IS INHERITED DOWNSTREAM: if my callers went quiet or down, my own
        soft = sc.z[a:b][:, :, soft_cols].max(axis=(0, 2))         # quietness is theirs, not mine (nobody is calling me).
        quiet = sc.z[a:b][:, :, quiet_cols].max(axis=(0, 2))       # A stopped container (container_up) is a fact and is never
        loud_own = [k for k, f in enumerate(fs) if SPEC[f][2] == "own" and k not in soft_cols]   # explained away.
        rest = sc.z[a:b][:, :, loud_own].max(axis=(0, 2)) if loud_own else np.zeros(len(p.services))
        idx0 = {s_: i for i, s_ in enumerate(p.services)}; ups = {}
        for c_, e_ in p.edges:
            if c_ in idx0 and e_ in idx0:
                ups.setdefault(idx0[e_], []).append(idx0[c_])
        downs = {}
        for c_, e_ in p.edges:
            if c_ in idx0 and e_ in idx0:
                downs.setdefault(idx0[c_], []).append(idx0[e_])
        sym_w = sc.sym[a:b].max(axis=0)
        loud = np.maximum(rest, sym_w)                              # a callee's LOUD evidence
        idle = np.where(sym_w < 3.0, quiet, 0.0)                    # a caller that is quiet AND error-free is idle; one that is quiet
        q_expl = np.array([max(max((idle[c_] for c_ in ups.get(i, [])), default=0.0),           # but erroring is BLOCKED on me
                               max((loud[e_] for e_ in downs.get(i, [])), default=0.0))         # or a callee broke loudly, so my
                           for i in range(len(p.services))])                                    # requests fail fast
        # Measured limit (live docker pause on DeathStar, 2026-10-08): a freeze stalls the whole call chain above it, so callers
        # go quiet without logging errors and look idle; with docker-stats data alone the frozen service is DETECTED (silence)
        # but not LOCALISED (rank 6-8 of 27). A rule for "deepest silent service" was tried and reverted: it did not fix the
        # live case and lowered bench accuracy (frozen-service A@1 1.00 -> 0.80). Per-request traces are needed here.
        own = np.maximum(rest, np.maximum(0.0, soft - gamma * q_expl))
    evidence = np.maximum(own, sym) if explain == "all" else own    # "own": only a callee's OWN evidence explains its callers
    if explain == "binary":                             # inherited if ANY callee is itself anomalous (raw evidence incl. silence,
        raw = np.maximum(own_raw, sym)                  # before it was explained away), however the z-scales compare
        explained = np.array([sym[i] if max((raw[w] for w in callees.get(i, [])), default=0.0) >= 3.0 else 0.0 for i in range(len(p.services))])
    else:
        explained = np.array([gamma * max((evidence[w] for w in callees.get(i, [])), default=0.0) for i in range(len(p.services))])
    unexpl = np.maximum(0.0, sym - explained)
    final = np.maximum(own, unexpl)
    note = [""] * len(p.services)
    if hard and "container_up" in fs:
        k = fs.index("container_up")
        for i in np.flatnonzero(sc.z[a:b, :, k].max(axis=0) >= 5.0):
            final[i] += 100.0; note[i] = "STOPPED (hard evidence)"
    judged = sc.judged[a:b].any(axis=0)
    if infer:
        for i in range(len(p.services)):
            if not judged[i] and callers.get(i):
                guess = 0.9 * max(unexpl[c] for c in callers[i])
                if guess > final[i]:
                    final[i], note[i] = guess, "inferred: silent, callers have unexplained symptoms"
    top = [fs[int(np.argmax(sc.z[a:b, i].max(axis=0)))] if sc.z[a:b, i].max() > 0 else "" for i in range(len(p.services))]
    out = pd.DataFrame({"service": p.services, "score": final, "own": own, "symptoms": sym, "explained": explained,
                        "unexplained": unexpl, "top_feature": top, "note": note})
    return out.sort_values("score", ascending=False).reset_index(drop=True)

def risk(p, sc, fl, t, tau, edge_prob=None):
    idx = {s: i for i, s in enumerate(p.services)}; out = {}
    for c, e in p.edges:
        if fl[t, idx[e]] and not fl[t, idx[c]]:
            sev = min(1.0, sc.zs[t, idx[e]] / (2 * tau))
            out[c] = 1 - (1 - out.get(c, 0.0)) * (1 - sev * (edge_prob or {}).get((c, e), 0.5))
    return pd.Series(out, dtype=float).sort_values(ascending=False)

def callers_of(edges):
    up = {}
    for c, e in edges:
        up.setdefault(e, []).append(c)
    return up

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

# ====================================== end of verbatim copy ======================================


# ============================== lab glue (not part of the method) ==============================
# Lab feature names -> the method's names. Memory arrives in bytes; the method's floor/unit is in MB.
LAB_TO_CORE = {"cpu": "cpu_percent", "memory": "memory_usage_mb", "net_rx": "network_rx_bytes", "net_tx": "network_tx_bytes",
               "log_errors": "error_count", "latency_p95": "latency_p95", "trace_errors": "trace_errors", "span_rate": "span_rate",
               "self_latency": "self_latency", "container_up": "container_up"}
LIVE_KW = dict(window=60, min_base=12, silence_k=6)          # as in the notebook's analyse_live (section 11c)


def panel_from_telemetry(tel) -> Panel:
    """A lab Telemetry cube (rates already computed) as the method's Panel. Features with no data at all are left out."""
    feats, cols = [], []
    for k, f in enumerate(tel.features):
        col = np.asarray(tel.X[:, :, k], float)
        if f not in LAB_TO_CORE or np.isnan(col).all():
            continue
        feats.append(LAB_TO_CORE[f]); cols.append(col / 1e6 if f == "memory" else col)
    if "network_rx_bytes" in feats and "network_tx_bytes" in feats:     # prepare() derives this for SSH data; so do we
        feats.append("activity"); cols.append(cols[feats.index("network_rx_bytes")] + cols[feats.index("network_tx_bytes")])
    step = float(np.median(np.diff(tel.times))) if len(tel.times) > 1 else 15.0
    return Panel(np.asarray(tel.times, float), list(tel.services), feats, np.stack(cols, axis=2),
                 [tuple(e) for e in tel.edges], step)


def live_detect(p: Panel, budget=2.0, persistence=2):
    """Score, normalise and threshold live data the way analyse_live() does when there is no fault ledger: every tick counts
    as healthy history, and tau is held at >= 4.0 until 30 minutes of history exist."""
    sc = score(p, **LIVE_KW)
    scn = normalise(sc, sc, features=p.features)
    tau = calibrate(scn, p.step, budget, persistence)
    if len(p.times) * p.step / 60 < 30:
        tau = max(tau, 4.0)
    return scn, tau, flags_for(scn, tau, persistence)


def alarm_window(fl, t, lookback=12):
    """(a, b) of the alarm episode that is active at tick t, or None. Active = some service flagged in the last `lookback`
    ticks; the window reaches back to where that episode started, and ends at t (no look-ahead)."""
    lo = max(0, t - lookback + 1)
    hits = np.flatnonzero(fl[lo:t + 1].any(axis=1))
    if not len(hits):
        return None
    a = lo + int(hits[0])
    while a > 0 and fl[max(0, a - lookback):a].any():
        a -= 1
    return a, t + 1


_BENCH_LIVE: dict = {}


def bench_state(seed: int):
    """The report's bench for one seed, scored once: (clean, panel, ledger, normalised scores, tau, flags, per-fault results)."""
    if seed not in _BENCH_LIVE:
        clean, p, ledger = make_bench(seed)
        kw = {k: DEFAULT[k] for k in ("window", "min_base", "common_frac", "log_scale", "self_heal", "tail_q", "binomial", "smooth",
                                      "win_k", "silence_k")}
        sc, scc = score(p, **kw), score(clean, **kw)
        sc, scc = normalise(sc, scc), normalise(scc, scc)
        tau = calibrate(scc, p.step, DEFAULT["budget"], DEFAULT["persistence"])
        _, R = run(seed=seed)
        _BENCH_LIVE[seed] = (clean, p, ledger, sc, tau, flags_for(sc, tau, DEFAULT["persistence"]), R)
    return _BENCH_LIVE[seed]


# The real crash (report section 12, notebook section 9): DeathStarBench on AWS, post-storage-service stopped for ~2 min.
# The hand-written call graph below is copied verbatim from the notebook (lines 92-100).
DS_CALL_GRAPH = [("nginx-thrift", x) for x in ("compose-post-service", "home-timeline-service", "user-timeline-service", "user-service", "social-graph-service")] +     [("compose-post-service", x) for x in ("text-service", "media-service", "unique-id-service", "user-service", "post-storage-service", "user-timeline-service", "home-timeline-service")] +     [("text-service", "url-shorten-service"), ("text-service", "user-mention-service"),
     ("url-shorten-service", "url-shorten-memcached"), ("url-shorten-service", "url-shorten-mongodb"),
     ("user-mention-service", "user-memcached"), ("user-mention-service", "user-mongodb"),
     ("user-service", "user-memcached"), ("user-service", "user-mongodb"), ("user-service", "social-graph-service"),
     ("social-graph-service", "social-graph-redis"), ("social-graph-service", "social-graph-mongodb"), ("social-graph-service", "user-service"),
     ("home-timeline-service", "home-timeline-redis"), ("home-timeline-service", "post-storage-service"), ("home-timeline-service", "social-graph-service"),
     ("user-timeline-service", "user-timeline-redis"), ("user-timeline-service", "user-timeline-mongodb"), ("user-timeline-service", "post-storage-service"),
     ("post-storage-service", "post-storage-memcached"), ("post-storage-service", "post-storage-mongodb"),
     ("media-service", "media-memcached"), ("media-service", "media-mongodb"), ("media-frontend", "media-mongodb")]
_CRASH: dict = {}


def crash_state():
    """The real DeathStar crash scored as in the notebook's ds_case(): 10 s ticks, window 30, min_base 8, silence on, tau 6.0."""
    if not _CRASH:
        ev = json.loads((ROOT / "docs/experiments/ssh_crash_events.json").read_text())
        rows = []
        for line in (ROOT / "samples/death-star-crash.jsonl").read_text().splitlines():
            r = json.loads(line)
            for n, v in r["svc"].items():
                rows.append(dict(timestamp=pd.Timestamp(r["t"], unit="s", tz="UTC"), service=n, cpu_percent=v["cpu"],
                                 memory_usage_mb=v["mem"] / 1e6, network_rx_bytes=v["rx"], network_tx_bytes=v["tx"],
                                 error_count=np.nan if v["err"] is None else v["err"]))
        p = prepare(pd.DataFrame(rows), step=10, track_presence=True, edges=DS_CALL_GRAPH)
        sc = score(p, window=30, min_base=8, silence_k=6)
        a = int(np.searchsorted(p.times, ev["t_stop"])); b = int(np.searchsorted(p.times, ev["t_start"]))
        tau = 6.0
        fl = flags_for(sc, tau, 2)
        att = attribute(p, sc, (a - 2, b + 1))
        rank_ = int(np.flatnonzero(att.service == ev["container"])[0]) + 1
        R = pd.DataFrame([{"rank": rank_}])
        _CRASH.update(p=p, ledger=[{"root": ev["container"], "kind": "crash (docker stop)", "a": a, "b": b}], sc=sc, tau=tau, fl=fl, R=R,
                      false_flags_before=int(fl[:a - 2].sum()), seconds=round(ev["t_start"] - ev["t_stop"]))
    c = _CRASH
    return None, c["p"], c["ledger"], c["sc"], c["tau"], c["fl"], c["R"]

"""The algorithms, and nothing else: no files, no network, no plotting, no framework.

    detection   score(), normalise(), calibrate(), flags_for()      "is something wrong?" (no labels, no training)
    RCA         attribute()                                          "which service broke first?"
    cascade     risk()                                               "who is dragged down next?"
    graph       compose_edges(), edges_from_graph(), merge_edges(), callers_of()

Everything below the banner lines is copied verbatim from the research notebook (colab/rca_research_src.py), the same
code the statistical report measured: 751 labelled faults, root ranked first 69.5% of the time, 0.15 false alarms an hour.
The graph section is new and only reshapes data the collectors already hold.

Inputs are a core.preprocessing.Panel (the data cube) and the Scores this module returns. Nothing here knows where data
came from, so it runs unchanged on the bench, on a recorded crash, and on live systems.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .preprocessing.prepare import Panel
from .preprocessing.spec import FLOOR, SPEC, UNIT

# ====================================================== GRAPH BUILDING ======================================================
# A graph is a list of (caller, callee) pairs. Declared edges come from configuration, observed edges from live traffic;
# compose `depends_on` is START ORDER, not who calls whom, so it is weaker evidence than anything observed.


def compose_edges(text: str) -> list[tuple[str, str]]:
    """(caller, callee) pairs from `depends_on` / `links` of a docker-compose file's text."""
    import yaml
    edges = set()
    for svc, spec in ((yaml.safe_load(text) or {}).get("services") or {}).items():
        for key in ("depends_on", "links"):
            deps = (spec or {}).get(key) or []
            for d in (deps if isinstance(deps, (list, dict)) else [deps]):
                edges.add((svc, str(d).split(":")[0]))
    return sorted(edges)


def edges_from_graph(graph: dict, observed_only: bool = False, min_samples_per_min: float = 0.0) -> list[tuple[str, str]]:
    """(caller, callee) pairs from the graph service's `GET /api/graph` payload, using each node's NAME.

    Every edge there says whether it is declared (written in config), observed (a live connection was seen) or both.
    observed_only drops edges nobody was seen using; min_samples_per_min drops barely-active ones.
    """
    name = {n["id"]: n.get("name", n["id"]) for n in graph.get("nodes", [])}
    out = set()
    for e in graph.get("edges", []):
        if observed_only and not (e.get("observed") or "network-tcp" in (e.get("evidenceSources") or [])):
            continue
        if (e.get("activity") or {}).get("samplesPerMin", min_samples_per_min) < min_samples_per_min:
            continue
        a, b = name.get(e.get("source")), name.get(e.get("target"))
        if a and b and a != b:
            out.add((a, b))
    return sorted(out)


def merge_edges(*edge_lists: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Union of several edge lists, without duplicates and without self-loops."""
    return sorted({(a, b) for edges in edge_lists for a, b in edges if a != b})


def callers_of(edges):
    """{callee: [callers]}. Failure travels the other way: from a callee up to the services that call it."""
    up = {}
    for c, e in edges:
        up.setdefault(e, []).append(c)
    return up


# ============================================ verbatim from colab/rca_research_src.py ============================================

# ------------------------------------------------------------ detection: score
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

# ------------------------------------------------------- detection: threshold and persistence
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

# ----------------------------------------------------------- RCA: source or victim?
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

# --------------------------------------------------------------- cascade risk
def risk(p, sc, fl, t, tau, edge_prob=None):
    idx = {s: i for i, s in enumerate(p.services)}; out = {}
    for c, e in p.edges:
        if fl[t, idx[e]] and not fl[t, idx[c]]:
            sev = min(1.0, sc.zs[t, idx[e]] / (2 * tau))
            out[c] = 1 - (1 - out.get(c, 0.0)) * (1 - sev * (edge_prob or {}).get((c, e), 0.5))
    return pd.Series(out, dtype=float).sort_values(ascending=False)
# ======================================================= end of verbatim copy ======================================================


# ============================== added for live use (not in the notebook; covered by core/tests) ==============================


def live_threshold(sc: Scores, step: float, budget: float = 2.0, persistence: int = 2, calib_min: float = 30.0, holdout_min: float = 3.0):
    """Normalise live scores and pick the alarm threshold when there is NO fault ledger to say which ticks were healthy.

    The notebook's analyse_live() calibrates on ticks that its ledger marks healthy. Live data has no ledger, and calibrating on
    everything lets a fault inflate its own noise estimate and threshold (a stopped container would then raise tau above its own
    score). So the reference is an EARLY slice, at most the first `calib_min` minutes of history, and the newest `holdout_min`
    minutes are never part of it. Start the system healthy; the threshold is then fixed by history that predates any fault. Known
    limit: a fault that begins in the first half hour and lasts longer than the hold-out leaks into the reference and is
    under-scored (a stopped container is exempt, see below).
    Until `calib_min` of reference exist, tau is held at >= 4.0 (a per-hour budget cannot be calibrated from a few minutes).
    Returns (normalised scores, tau, flags).
    """
    T = sc.zs.shape[0]
    end = min(T - int(holdout_min * 60 / step), int(calib_min * 60 / step))
    if end < 12:
        end = T                                                      # too little history to hold anything out
    cut = lambda a: a[:end]
    z_ref = cut(sc.z).copy()
    if "container_up" in sc.features:                                # a stopped container is a fact, not noise: never shrink it
        z_ref[:, :, sc.features.index("container_up")] = 0.0
    ref = Scores(z_ref, cut(sc.med), cut(sc.scale), cut(sc.own), cut(sc.sym), cut(sc.zs), cut(sc.judged), cut(sc.common), sc.features)
    scn = normalise(sc, ref, features=sc.features)
    tau = calibrate(normalise(ref, ref, features=sc.features), step, budget, persistence)
    if end * step / 60 < calib_min:
        tau = max(tau, 4.0)
    return scn, tau, flags_for(scn, tau, persistence)


def alarm_window(flags: np.ndarray, t: int, lookback: int = 12):
    """(a, b) of the alarm episode that is active at tick t, or None. Active = some service was flagged in the last `lookback`
    ticks; the window reaches back to where that episode started and ends at t (no look-ahead)."""
    lo = max(0, t - lookback + 1)
    hits = np.flatnonzero(flags[lo:t + 1].any(axis=1))
    if not len(hits):
        return None
    a = lo + int(hits[0])
    while a > 0 and flags[max(0, a - lookback):a].any():
        a -= 1
    return a, t + 1

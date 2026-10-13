"""Semi-synthetic evaluation: inject faults into REAL (or bootstrapped-real) telemetry.

Why: pure synthetic data encodes our own assumptions and has unrealistically clean noise. Here the *background* is real
(bursty, non-stationary, correlated through shared load); only the fault and its propagation are simulated. Ground truth
(root, onset, who is affected and when) comes from the injection, never from our detector, so labels are not circular.

What stays an assumption (state it in the paper): how a fault changes latency/errors, and how propagation proceeds
(per-edge probability, 0-1 window lag, decaying magnitude).
"""
from __future__ import annotations

import numpy as np

from .telemetry import Telemetry


def make_edge_probs(edges, rng, shielded_frac: float = 0.5, p_open: float = 0.9, p_shield: float = 0.1) -> dict:
    """Per-edge propagation probability q[(caller, callee)]. Heterogeneous on purpose: real systems have retries,
    timeouts, caches and circuit breakers, so some callers are shielded from a failing callee and some are not."""
    return {e: (p_shield if rng.random() < shielded_frac else p_open) for e in edges}


def inject(tel: Telemetry, root: str, onset: int, q: dict, rng, duration: int = 24, max_depth: int = 3,
           lag: tuple[int, int] = (0, 1), m_self: float | None = None):
    """Return (new telemetry, truth). truth = {root, onset, end, affected: {service: onset_window}}."""
    F = tel.features
    ix = {f: F.index(f) for f in ("latency_p95", "self_latency", "trace_errors", "span_rate")}
    X = tel.X.copy()
    T = X.shape[0]
    callers: dict[str, list[str]] = {}
    for caller, callee in tel.edges:
        callers.setdefault(callee, []).append(caller)

    affected = {root: (onset, 0)}                       # service -> (onset window, depth)
    frontier = [root]
    while frontier:
        nxt = []
        for callee in frontier:
            t0, d = affected[callee]
            if d >= max_depth:
                continue
            for caller in callers.get(callee, []):
                if caller not in affected and rng.random() < q.get((caller, callee), 0.5):
                    affected[caller] = (t0 + int(rng.integers(lag[0], lag[1] + 1)), d + 1)
                    nxt.append(caller)
        frontier = nxt

    m_self = float(m_self) if m_self is not None else float(np.clip(rng.lognormal(np.log(4.0), 0.35), 2.0, 10.0))
    e0 = float(rng.choice([0.0, 0.05, 0.15, 0.3]))
    for svc, (t0, depth) in affected.items():
        j = tel.index(svc)
        t1 = min(t0 + duration, T)
        if t0 >= T:
            continue
        sl = slice(t0, t1)
        has_traffic = np.nan_to_num(X[sl, j, ix["span_rate"]]) > 0
        if depth == 0:                                  # the true source: itself slow
            X[sl, j, ix["latency_p95"]] *= m_self
            X[sl, j, ix["self_latency"]] *= m_self
            add = e0
            X[sl, j, ix["span_rate"]] *= rng.uniform(0.5, 1.0)
        else:                                           # a victim: waits on its callee, so total time rises, self time does not
            rho = rng.uniform(0.4, 1.3) * 0.8 ** (depth - 1)
            X[sl, j, ix["latency_p95"]] *= 1.0 + (m_self - 1.0) * rho
            add = e0 * rng.uniform(0.2, 0.8)
            X[sl, j, ix["span_rate"]] *= rng.uniform(0.7, 1.0)
        te = np.nan_to_num(X[sl, j, ix["trace_errors"]])
        X[sl, j, ix["trace_errors"]] = np.where(has_traffic, np.minimum(te + add, 1.0), X[sl, j, ix["trace_errors"]])
    truth = {"root": root, "onset": onset, "end": min(onset + duration, T), "affected": {s: v[0] for s, v in affected.items()},
             "m_self": m_self, "error_add": e0}
    return Telemetry(tel.times, tel.services, X, tel.features, tel.edges), truth

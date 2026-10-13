"""Synthetic microservice telemetry with a known injected fault and cascade.

Used only to develop and unit-test the pipeline without a live stack.
"""
from __future__ import annotations

import numpy as np

from .telemetry import FEATURES, Telemetry

# caller -> callees (a small e-commerce-like DAG)
CALLS = {
    "frontend": ["catalogue", "cart", "orders"],
    "cart": ["cart-db"],
    "catalogue": ["catalogue-db"],
    "orders": ["payment", "shipping", "orders-db"],
    "shipping": ["queue"],
}


def make(root: str, n: int = 120, baseline: int = 40, onset: int = 60, seed: int = 0,
         lag_range: tuple[int, int] = (1, 2), p_propagate: float = 0.85,
         root_mag: float = 6.0, victim_mag: float = 4.0, noise: float = 1.0):
    rng = np.random.default_rng(seed)
    services = sorted({s for c, es in CALLS.items() for s in [c, *es]})
    edges = [(c, e) for c, es in CALLS.items() for e in es]
    S, F = len(services), len(FEATURES)
    level = np.array([100.0, 5e8, 2e4, 2e4, 0.5, 40.0, 0.01, 60.0, 15.0, 1.0])  # typical magnitudes
    X = level * (1 + 0.04 * noise * rng.standard_normal((n, S, F)))
    X[:, :, FEATURES.index("log_errors")] = rng.poisson(0.4 * noise, (n, S))
    X[:, :, FEATURES.index("container_up")] = np.nan          # host-level signal; not simulated
    X[:, :, FEATURES.index("trace_errors")] = np.abs(rng.normal(0.01, 0.005 * noise, (n, S)))
    idx = {s: i for i, s in enumerate(services)}

    def hit(svc, t0, mag):
        i = idx[svc]
        X[t0:, i, FEATURES.index("latency_p95")] *= mag
        X[t0:, i, FEATURES.index("trace_errors")] += 0.3 * min(mag, 3) / 3
        X[t0:, i, FEATURES.index("cpu")] *= 1 + 0.5 * min(mag, 4)
        X[t0:, i, FEATURES.index("log_errors")] += 4 * min(mag, 4)
        X[t0:, i, FEATURES.index("span_rate")] *= 0.5     # failing services serve less traffic

    hit(root, onset, root_mag)
    X[onset:, idx[root], FEATURES.index("self_latency")] *= root_mag     # exclusive time rises only at the true source
    frontier, seen = [(root, onset)], {root}
    while frontier:
        svc, t0 = frontier.pop()
        for caller, callee in edges:
            if callee == svc and caller not in seen and rng.random() < p_propagate:
                seen.add(caller)
                t1 = t0 + int(rng.integers(*lag_range, endpoint=True))
                if t1 < n:
                    hit(caller, t1, victim_mag)
                    frontier.append((caller, t1))
    times = 1_700_000_000 + 15.0 * np.arange(n)
    return Telemetry(times, services, X, list(FEATURES), edges), {"service": root, "onset": onset,
                                                                     "baseline": baseline}

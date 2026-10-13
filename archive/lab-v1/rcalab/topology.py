"""Larger synthetic applications whose background telemetry is bootstrapped from REAL healthy telemetry.

random_dag: a layered call graph with a heavy-tailed fan-out (a few hub services, many leaves), like real systems.
bootstrap_telemetry: each synthetic service replays a real service's series using a SHARED block schedule, so the global
load waves that hit all services together in real traffic are kept (independent noise would make false alarms look
better than they are).
"""
from __future__ import annotations

import numpy as np

from .telemetry import Telemetry


def random_dag(n: int, rng, layers: int = 6, hub_share: float = 0.1):
    names = [f"svc{i:03d}" for i in range(n)]
    layer = np.sort(rng.integers(0, layers, n))
    layer[0] = 0
    edges = set()
    hubs = set(rng.choice(n, max(1, int(hub_share * n)), replace=False).tolist())
    for i in range(n):
        lower = np.where(layer > layer[i])[0]
        if len(lower) == 0:
            continue
        k = int(min(len(lower), 1 + rng.zipf(1.8))) if i in hubs else int(min(len(lower), rng.integers(0, 3)))
        for c in rng.choice(lower, k, replace=False) if k else []:
            edges.add((names[i], names[int(c)]))
    for i in range(1, n):                               # every service is reachable from some caller
        if not any(e[1] == names[i] for e in edges):
            upper = np.where(layer < layer[i])[0]
            if len(upper):
                edges.add((names[int(rng.choice(upper))], names[i]))
    return names, sorted(edges)


def bootstrap_telemetry(real: Telemetry, names: list[str], edges, T: int, rng, block: int = 12) -> Telemetry:
    span = real.features.index("span_rate")
    active = [i for i in range(len(real.services)) if np.nansum(real.X[:, i, span]) > 50]
    src = rng.choice(active, len(names))                # which real service each synthetic one imitates
    scale = np.exp(rng.normal(0, 0.3, len(names)))      # services differ in size
    n_real = real.X.shape[0]
    assert T <= n_real, f"need at least {T} real windows, have {n_real}"
    # Contiguous real history for every service (no splice points, which created artificial jumps). Services that imitate the
    # same real service are decorrelated by a small circular time shift, so a 500-service app is not 500 copies of 16 series.
    shifts = rng.integers(-8, 9, len(names))
    X = np.empty((T, len(names), real.X.shape[2]))
    for j, (s, sh) in enumerate(zip(src, shifts)):
        X[:, j, :] = real.X[(np.arange(T) + int(sh)) % n_real, s, :]
    for j, f in enumerate(real.features):
        if f in ("latency_p95", "self_latency", "span_rate"):
            X[:, :, j] *= scale
    times = real.times[0] + (real.times[1] - real.times[0]) * np.arange(T)
    return Telemetry(times, names, X, real.features, edges)

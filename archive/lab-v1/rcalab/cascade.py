"""Probabilistic cascading-failure model over the trace-derived call graph.

A failing callee degrades its callers, so influence flows callee -> caller.
Edge probabilities p(callee -> caller) are *learned online from unlabeled anomaly flags*:
    p = (n_both + prior*strength) / (n_callee_anom + strength)
where n_both counts windows where the callee was anomalous and the caller became
anomalous within `max_lag` windows. The call graph itself is the structural prior.
"""
from __future__ import annotations

import heapq

import numpy as np

from .telemetry import Telemetry


def edge_probabilities(tel: Telemetry, flags: np.ndarray, max_lag: int = 4,
                       prior: float = 0.5, strength: float = 2.0) -> dict[tuple[str, str], float]:
    """Return {(callee, caller): p} for each observed call edge."""
    T = flags.shape[0]
    probs = {}
    for caller, callee in tel.edges:
        if caller not in tel.services or callee not in tel.services:
            continue
        ci, ei = tel.index(caller), tel.index(callee)
        n_e = n_both = 0
        for t in range(T):
            if flags[t, ei] and (t == 0 or not flags[t - 1, ei]):  # onset of callee anomaly
                n_e += 1
                n_both += bool(flags[t:t + max_lag + 1, ci].any())
        probs[(callee, caller)] = (n_both + prior * strength) / (n_e + strength)
    return probs


def path_probabilities(services: list[str], probs: dict[tuple[str, str], float],
                       max_hops: int = 3) -> np.ndarray:
    """P[u, v] = best (max-product) propagation probability from u to v within max_hops."""
    n = len(services)
    idx = {s: i for i, s in enumerate(services)}
    adj: dict[int, list[tuple[int, float]]] = {i: [] for i in range(n)}
    for (u, v), p in probs.items():
        adj[idx[u]].append((idx[v], p))
    P = np.zeros((n, n))
    for src in range(n):
        best = {src: (1.0, 0)}
        heap = [(-1.0, src, 0)]
        while heap:
            negp, u, hops = heapq.heappop(heap)
            if -negp < best[u][0] or hops == max_hops:
                continue
            for v, p in adj[u]:
                cand = -negp * p
                if v not in best or cand > best[v][0]:
                    best[v] = (cand, hops + 1)
                    heapq.heappush(heap, (-cand, v, hops + 1))
        for v, (p, _) in best.items():
            if v != src:
                P[src, v] = p
    return P


def cascade_risk(a_now: np.ndarray, P: np.ndarray) -> np.ndarray:
    """Probability each service is pulled into an incident by *other* services' anomalies.

    risk[v] = 1 - prod_u (1 - a_u * P[u, v])   (noisy-OR over every upstream cause)
    """
    contrib = 1.0 - a_now[:, None] * P
    np.fill_diagonal(contrib, 1.0)
    return 1.0 - contrib.prod(axis=0)


class EdgeLearner:
    """Learns edge propagation probabilities ACROSS incidents instead of inside one.

    Inside a single incident an edge sees one or two callee onsets, so the estimate collapses to the prior (measured: 82% of
    edges stayed exactly at 0.5). Here every detected onset of the callee, in every incident seen so far, is one trial; a trial
    is a success if the caller flags within `max_lag` windows. Label-free: only detector flags are used, never ground truth.
    The prior is the pooled propagation rate over all edges (empirical Bayes) rather than a fixed 0.5.
    """

    def __init__(self, max_lag: int = 4, strength: float = 2.0):
        self.max_lag, self.strength = max_lag, strength
        self.n_e: dict[tuple[str, str], int] = {}
        self.n_both: dict[tuple[str, str], int] = {}

    def update(self, tel: Telemetry, flags: np.ndarray):
        T = flags.shape[0]
        for caller, callee in tel.edges:
            if caller not in tel.services or callee not in tel.services:
                continue
            ci, ei = tel.index(caller), tel.index(callee)
            key = (callee, caller)
            for t in range(T):
                if flags[t, ei] and (t == 0 or not flags[t - 1, ei]):
                    self.n_e[key] = self.n_e.get(key, 0) + 1
                    self.n_both[key] = self.n_both.get(key, 0) + int(flags[t:t + self.max_lag + 1, ci].any())

    def probs(self, edges) -> dict[tuple[str, str], float]:
        tot_e, tot_b = sum(self.n_e.values()), sum(self.n_both.values())
        p0 = (tot_b + 0.5) / (tot_e + 1.0) if tot_e else 0.5
        out = {}
        for caller, callee in edges:
            key = (callee, caller)
            out[key] = (self.n_both.get(key, 0) + self.strength * p0) / (self.n_e.get(key, 0) + self.strength)
        return out

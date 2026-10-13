"""Root cause ranking: combine anomaly strength, temporal precedence and cascade explanation."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .cascade import cascade_risk, edge_probabilities, path_probabilities
from .detector import Detection
from .telemetry import Telemetry


@dataclass
class RCAResult:
    ranking: list[tuple[str, float]]       # (service, score), best first
    onset: dict[str, int]                  # window index where each flagged service first deviated
    strength: dict[str, float]
    risk: dict[str, float]                 # cascade risk for every service
    P: np.ndarray                          # propagation probabilities, services x services
    services: list[str]


def rank(tel: Telemetry, det: Detection, window: tuple[int, int], max_lag: int = 4,
         max_hops: int = 3, method: str = "full", edge_probs: dict | None = None) -> RCAResult:
    """Rank candidate root causes inside window = (start, stop) of window indices.

    method: full | ablations (no_precedence, no_cascade, no_explained) |
    baselines (anomaly_only, earliest, random, pagerank).
    """
    s0, s1 = window
    flags = det.flags[s0:s1]
    cand = [i for i in range(len(tel.services)) if flags[:, i].any()]
    strength = {i: float(det.a[s0:s1, i].max()) for i in cand}
    onset = {i: int(np.argmax(flags[:, i])) + s0 for i in cand}

    probs = edge_probs if edge_probs is not None else edge_probabilities(tel, det.flags[:s1], max_lag)   # only data available at time s1 (no look-ahead)
    P = path_probabilities(tel.services, probs, max_hops)

    scores = {}
    if method == "random":
        rng = np.random.default_rng(0)
        scores = {i: float(rng.random()) for i in cand}
    elif method == "anomaly_only":
        scores = dict(strength)
    elif method == "earliest":
        scores = {i: -onset[i] + 1e-3 * strength[i] for i in cand}
    elif method == "selftime":
        # Rank by how abnormal each service's OWN (exclusive) time is: waiting on a slow callee does not raise it.
        # Self time comes from traces only. Without it (SSH data) every score would be 0 and the ranking a tie, so fall
        # back to anomaly strength instead of presenting noise as a result.
        k = tel.features.index("self_latency")
        own = {i: float(det.feature_z[s0:s1, i, k].max()) for i in cand}
        scores = {i: own[i] + 1e-3 * strength[i] for i in cand} if any(v > 0 for v in own.values()) else dict(strength)
    elif method == "pagerank":
        scores = _pagerank_baseline(tel, cand, strength)
    else:
        # full method and its ablations
        w_prec, w_blast, w_expl = {"no_precedence": (0.0, 1.0, 0.8), "no_cascade": (1.0, 0.0, 0.8),
                                   "no_explained": (0.4, 0.6, 0.0)}.get(method, (0.4, 0.6, 0.8))
        total = sum(strength.values()) or 1.0
        t_min, t_max = (min(onset.values()), max(onset.values())) if cand else (0, 0)
        for u in cand:
            prec = 1.0 if t_max == t_min else 1.0 - (onset[u] - t_min) / (t_max - t_min)
            blast = sum(P[u, v] * strength[v] for v in cand if v != u) / total
            # How much of u's own anomaly is already explained by an earlier failing upstream cause?
            explained = max((P[w, u] * strength[w] for w in cand if w != u and onset[w] <= onset[u]),
                            default=0.0)
            scores[u] = strength[u] * (w_prec * prec + w_blast * blast) * (1.0 - w_expl * explained)

    ranking = sorted(((tel.services[i], sc) for i, sc in scores.items()), key=lambda x: -x[1])
    a_now = det.a[s1 - 1]
    risk = cascade_risk(a_now, P)
    return RCAResult(ranking=ranking,
                     onset={tel.services[i]: t for i, t in onset.items()},
                     strength={tel.services[i]: v for i, v in strength.items()},
                     risk={s: float(r) for s, r in zip(tel.services, risk)},
                     P=P, services=tel.services)


def _pagerank_baseline(tel: Telemetry, cand: list[int], strength: dict[int, float],
                       damping: float = 0.85, iters: int = 100) -> dict[int, float]:
    """MicroRCA-style baseline (simplified re-implementation, not the authors' code).

    Personalised PageRank on the service graph with *reversed* call edges (caller -> callee, so
    probability mass flows toward dependencies), edge weights = callee anomaly, teleport vector =
    anomaly strength. Highest-ranked anomalous service = root cause.
    """
    n = len(tel.services)
    a = np.zeros(n)
    for i, v in strength.items():
        a[i] = v
    W = np.zeros((n, n))
    for caller, callee in tel.edges:
        if caller in tel.services and callee in tel.services:
            W[tel.index(caller), tel.index(callee)] = a[tel.index(callee)] + 1e-3
    W[:, :] += np.diag(a * 0.1)                                  # self-loop keeps mass on anomalous nodes
    rows = W.sum(axis=1, keepdims=True)
    T = np.divide(W, rows, out=np.zeros_like(W), where=rows > 0)
    tele = a / a.sum() if a.sum() else np.full(n, 1.0 / n)
    r = tele.copy()
    for _ in range(iters):
        r = (1 - damping) * tele + damping * (r @ T + r * (rows.ravel() == 0))
    return {i: float(r[i]) for i in cand}

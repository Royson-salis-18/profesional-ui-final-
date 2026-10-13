"""Unsupervised per-service anomaly detection. No labels are used anywhere here.

Calibrate on a baseline slice of *normal* operation, then score every window.
Output `z` is "how many robust standard deviations from normal", `a` maps it to (0, 1).
"""
from __future__ import annotations

from dataclasses import dataclass

import warnings

import numpy as np

from .telemetry import Telemetry

# Absolute scale floors so a flat-zero baseline (e.g. error counts) does not give infinite z.
_ABS_FLOOR = {"cpu": 0.01, "memory": 1e6, "net_rx": 1e3, "net_tx": 1e3,
              "log_errors": 1.0, "latency_p95": 1.0, "trace_errors": 0.05, "span_rate": 2.0, "self_latency": 1.0, "container_up": 0.1}


@dataclass
class Detection:
    z: np.ndarray            # (T, S) service-level deviation score
    a: np.ndarray            # (T, S) anomaly probability-like score in (0, 1)
    flags: np.ndarray        # (T, S) bool, sustained z >= threshold
    feature_z: np.ndarray    # (T, S, F) per-feature deviation, for explanations


def _calibrate(base: np.ndarray, features: list[str]):
    with warnings.catch_warnings():                        # features with no data at all stay NaN -> no evidence
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(base, axis=0)                   # (S, F)
        mad = np.nanmedian(np.abs(base - med), axis=0) * 1.4826
    floor = np.array([_ABS_FLOOR[f] for f in features])
    med, mad = np.nan_to_num(med), np.nan_to_num(mad)      # no baseline data -> neutral, floor decides
    scale = np.maximum.reduce([mad, 0.1 * np.abs(med), np.broadcast_to(floor, med.shape)])
    return med, scale


# Direction in which a feature indicates trouble: +1 = increase, -1 = decrease. Only that side counts.
_DIRECTION = {"cpu": 1, "memory": 1, "net_rx": 1, "net_tx": 1, "log_errors": 1, "latency_p95": 1,
              "trace_errors": 1, "span_rate": -1, "self_latency": 1, "container_up": -1}
_LINEAR = {"trace_errors", "container_up"}          # a rate in [0,1]; everything else is positive and heavy-tailed -> log scale


def _calibrated_fz(tel: Telemetry, fit_windows: int | None = None, min_scale: float = 0.15, min_valid: int = 20,
                   base_k: int = 40, min_spans: int = 3, min_rate: float = 15.0, return_evidence: bool = False):
    """One-sided, log-scale, CAUSAL robust deviation with explicit rules about when there is enough evidence.

    Fixes the sources of false alarms found on real healthy traffic:
      1. drops in latency / surges in load were counted as faults  -> one-sided per feature
      2. multiplicative noise judged on a linear scale             -> log scale for positive features
      3. services with no baseline (traffic starts later) or very few spans looked like +30 sigma events
         -> a feature is judged only after `min_valid` valid baseline samples (baseline = first `base_k` valid
            samples of that series, so late-appearing services calibrate themselves) and latency/error features count
            only in windows with at least `min_spans` spans
      4. "service went silent" on low-traffic services is just Poisson noise
         -> judged only when baseline traffic >= `min_rate` spans/window, with Poisson-aware scale
    """
    F = tel.features
    X = tel.X.copy()
    T, S, Fn = X.shape
    spans = np.nan_to_num(X[:, :, F.index("span_rate")])
    for f in ("latency_p95", "self_latency", "trace_errors"):
        if f in F:
            col = X[:, :, F.index(f)]
            col[spans < min_spans] = np.nan
    for j, f in enumerate(F):
        if f not in _LINEAR:
            X[:, :, j] = np.log1p(np.maximum(X[:, :, j], 0))
    fz = np.zeros((T, S, Fn))
    ev = np.zeros((T, S), dtype=bool)                  # True where at least one feature could actually be judged
    for j, f in enumerate(F):
        sign = _DIRECTION[f]
        floor = 0.02 if f in _LINEAR else min_scale
        for s in range(S):
            col = X[:, s, j]
            idx = np.flatnonzero(~np.isnan(col))
            if len(idx) < min_valid:
                continue
            base = col[idx[:base_k]]
            med = float(np.median(base))
            scale = max(float(np.median(np.abs(base - med))) * 1.4826, floor)
            if f == "span_rate":
                rate = float(np.expm1(med))
                if rate < min_rate:
                    continue
                scale = max(scale, 1.0 / np.sqrt(rate))
            z = np.maximum(sign * (np.nan_to_num(col, nan=med) - med) / scale, 0.0)
            z[:idx[min_valid - 1] + 1] = 0.0                  # still learning this service
            fz[:, s, j] = np.minimum(z, 50.0)
            judged = ~np.isnan(col)
            judged[:idx[min_valid - 1] + 1] = False
            ev[:, s] |= judged
    return (fz, ev) if return_evidence else fz


def _persist(raw: np.ndarray, ev: np.ndarray, persistence: int) -> np.ndarray:
    """Require `persistence` consecutive judged windows above threshold. A window with NO evidence (too few spans, service not
    yet calibrated) neither extends nor breaks a streak: it is unknown, not healthy."""
    if persistence <= 1:
        return raw.copy()
    run = np.zeros(raw.shape, dtype=int)
    for t in range(raw.shape[0]):
        prev = run[t - 1] if t else 0
        run[t] = np.where(raw[t], prev + 1, np.where(ev[t], 0, prev))
    flags = run >= persistence
    for t in range(raw.shape[0] - 1, -1, -1):          # back-fill the earlier windows of a confirmed streak
        if t + 1 < raw.shape[0]:
            flags[t] |= raw[t] & flags[t + 1]
    return flags


def calibrate_threshold(tel: Telemetry, fit_windows: int, cal_windows: int, budget_per_hour: float,
                        persistence: int = 3, grid=None) -> float:
    """Smallest threshold whose false-alarm EPISODES (onsets of a persistent flag, any service) on the healthy
    calibration slice [fit_windows, fit_windows+cal_windows) stay within `budget_per_hour` for the whole system."""
    step = float(tel.times[1] - tel.times[0])
    hours = cal_windows * step / 3600.0
    fz, ev = _calibrated_fz(tel, fit_windows, return_evidence=True)
    z = fz.max(axis=2)[fit_windows:fit_windows + cal_windows]
    ev = ev[fit_windows:fit_windows + cal_windows]
    for thr in (grid if grid is not None else np.arange(2.0, 30.0, 0.25)):
        f = _persist(z >= thr, ev, persistence)
        episodes = int((f[1:] & ~f[:-1]).sum() + f[0].sum())     # onsets of persistent flags
        if episodes / max(hours, 1e-9) <= budget_per_hour:
            return float(thr)
    return float(30.0)


def detect(tel: Telemetry, baseline_windows: int, z_threshold: float = 3.5,
           persistence: int = 2, kind: str = "robust_z") -> Detection:
    ev = np.ones(tel.X.shape[:2], dtype=bool)
    if kind == "calibrated":
        fz, ev = _calibrated_fz(tel, baseline_windows, return_evidence=True)
    else:
        med, scale = _calibrate(tel.X[:baseline_windows], tel.features)
        fz = np.abs(np.nan_to_num(tel.X, nan=0.0) - med) / scale
        # A missing sample means "no evidence", not "normal value": zero deviation.
        fz = np.where(np.isnan(tel.X), 0.0, fz)
        fz = np.minimum(fz, 50.0)

    if kind == "isolation_forest":
        z = _iforest_z(fz, baseline_windows)
    else:
        z = fz.max(axis=2)
    a = 1.0 / (1.0 + np.exp(-(z - z_threshold)))

    flags = _persist(z >= z_threshold, ev, persistence)
    return Detection(z=z, a=a, flags=flags, feature_z=fz)


def _iforest_z(fz: np.ndarray, baseline_windows: int) -> np.ndarray:
    from sklearn.ensemble import IsolationForest
    T, S, _ = fz.shape
    z = np.zeros((T, S))
    for s in range(S):
        m = IsolationForest(n_estimators=200, random_state=0).fit(fz[:baseline_windows, s])
        raw = -m.score_samples(fz[:, s])                   # higher = more anomalous
        ref = -m.score_samples(fz[:baseline_windows, s])
        z[:, s] = np.maximum(0, (raw - np.median(ref)) / (ref.std() + 1e-9))
    return z

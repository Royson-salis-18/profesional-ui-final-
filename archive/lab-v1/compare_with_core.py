"""Run the OLD lab method (archive/lab-v1/rcalab: robust-z calibrated detector + strength x precedence x blast-radius ranking) on the SAME labelled bench
the report method is judged on, so the two versions can be compared fairly. Usage (from the repo root): python archive/lab-v1/compare_with_core.py [n_seeds]"""
import sys, json
import numpy as np
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
from rcalab.telemetry import Telemetry, FEATURES
from rcalab.detector import detect, calibrate_threshold
from rcalab.rca import rank
from core.evaluation import bench

n_seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 20
MAP = {"latency_p95": "latency_p95", "trace_errors": "trace_errors", "span_rate": "span_rate", "self_latency": "self_latency", "container_up": "container_up"}
res = {m: [] for m in ("full", "selftime", "anomaly_only", "earliest", "random")}
fa = []
for seed in range(3, 3 + n_seeds):
    clean, p, ledger = bench.make_bench(seed)
    T, S = p.X.shape[:2]
    X = np.full((T, S, len(FEATURES)), np.nan)
    for j, f in enumerate(p.features):
        if f in MAP:
            X[:, :, FEATURES.index(MAP[f])] = p.X[:, :, j]
    tel = Telemetry(p.times, list(p.services), X, list(FEATURES), [tuple(e) for e in p.edges])
    base = 40
    tau = calibrate_threshold(Telemetry(clean.times, list(clean.services), np.where(np.isnan(X), np.nan, X), list(FEATURES), tel.edges), base, 100, 5.0, persistence=3)
    det = detect(tel, base, tau, persistence=3, kind="calibrated")
    healthy = np.ones(T, bool)
    for f in ledger:
        healthy[max(f["a"] - 2, 0):f["b"] + 8] = False
    flags = det.flags
    starts = (flags[1:] & ~flags[:-1])[healthy[1:]].sum()
    fa.append(starts / max(healthy.sum() * (p.times[1] - p.times[0]) / 3600, 1e-9))
    for f in ledger:
        a, b = f["a"], f["b"] + 4
        for m in res:
            try:
                r = rank(tel, det, (a, b), 4, 3, m)
                order = [s for s, _ in r.ranking]
                res[m].append(order.index(f["root"]) + 1 if f["root"] in order else 10 ** 6)
            except Exception:
                res[m].append(10 ** 6)
out = {m: dict(n=len(v), A1=float(np.mean(np.array(v) == 1)), A3=float(np.mean(np.array(v) <= 3))) for m, v in res.items()}
out["false_alarms_h_per_seed_mean"] = float(np.mean(fa))
print(json.dumps(out, indent=1))

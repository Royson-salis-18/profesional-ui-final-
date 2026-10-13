"""Score RCA methods against injected-fault labels and compare them statistically.

Protocol (see RESEARCH.md): per-run reciprocal rank / hit@k for every method on the SAME runs,
bootstrap CIs, paired Wilcoxon signed-rank tests of the proposed method vs each other method with
Holm correction, and Cliff's delta as effect size. Everything is written to results/<id>/.
"""
from __future__ import annotations

import csv
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
from scipy import stats

from . import store, synthetic
from .detector import detect
from .rca import rank
from .telemetry import Telemetry

PROPOSED = "full"
ABLATIONS = ["no_cascade", "no_precedence", "no_explained"]
BASELINES = ["pagerank", "anomaly_only", "earliest", "random"]
METHODS = [PROPOSED] + ABLATIONS + BASELINES


def score_one(tel: Telemetry, truth: str, inject_idx: int, baseline: int, cfg: dict,
              method: str) -> dict:
    d, c = cfg["detector"], cfg["cascade"]
    det = detect(tel, baseline, d["z_threshold"], kind=d["kind"])
    T = len(tel.times)

    def top_at(end: int):
        res = rank(tel, det, (baseline, end), c["max_lag_windows"], c["max_hops"], method)
        return [s for s, _ in res.ranking]

    names = top_at(T)
    r = names.index(truth) + 1 if truth in names else len(tel.services) + 1
    # Diagnosis delay: earliest time after injection from which top-1 stays correct. Uses only data
    # available at each time step (rank() does not look ahead).
    tops = [top_at(e) for e in range(inject_idx + 1, T + 1)]
    ok = [bool(t) and t[0] == truth for t in tops]
    delay = None
    for k in range(len(ok)):
        if all(ok[k:]):
            delay = (k + 1) * float(tel.times[1] - tel.times[0])
            break
    return {"rank": r, "rr": 1.0 / r, "delay_s": delay}


def _boot_ci(x: np.ndarray, seed: int = 0, n: int = 2000) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    means = [x[rng.integers(0, len(x), len(x))].mean() for _ in range(n)]
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def aggregate(rows: list[dict], top_k: list[int]) -> dict:
    ranks = np.array([r["rank"] for r in rows])
    out = {}
    for k in top_k:
        hit = (ranks <= k).astype(float)
        lo, hi = _boot_ci(hit)
        out[f"A@{k}"] = {"mean": float(hit.mean()), "ci95": [lo, hi]}
    rr = np.array([r["rr"] for r in rows])
    lo, hi = _boot_ci(rr)
    out["MRR"] = {"mean": float(rr.mean()), "ci95": [lo, hi]}
    d = [r["delay_s"] for r in rows if r["delay_s"] is not None]
    out["median_delay_s"] = float(np.median(d)) if d else None
    out["resolved"] = len(d) / len(rows)
    return out


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    gt = sum((x > y) for x in a for y in b)
    lt = sum((x < y) for x in a for y in b)
    return float((gt - lt) / (len(a) * len(b)))


def compare(results: dict[str, list[dict]]) -> dict:
    """Paired Wilcoxon on per-run reciprocal rank, proposed vs every other method, Holm-corrected."""
    base = np.array([r["rr"] for r in results[PROPOSED]])
    raw = {}
    for m, rows in results.items():
        if m == PROPOSED:
            continue
        other = np.array([r["rr"] for r in rows])
        try:
            p = float(stats.wilcoxon(base, other).pvalue) if np.any(base != other) else 1.0
        except ValueError:
            p = 1.0
        raw[m] = {"mean_diff_rr": float((base - other).mean()), "cliffs_delta": cliffs_delta(base, other),
                  "p_raw": p}
    order = sorted(raw, key=lambda m: raw[m]["p_raw"])           # Holm step-down
    running = 0.0
    for i, m in enumerate(order):
        running = max(running, min(1.0, raw[m]["p_raw"] * (len(order) - i)))
        raw[m]["p_holm"] = running
    return raw


def run_dir(cfg: dict, runs_dir: Path) -> dict:
    results = {m: [] for m in METHODS}
    meta = []
    for d in sorted(p for p in runs_dir.iterdir() if (p / "label.json").exists()):
        label = json.loads((d / "label.json").read_text())
        tel = store.load(d / "telemetry.npz")
        inject_idx = int(np.searchsorted(tel.times, label["t_inject"]))
        meta.append({"run": d.name, "service": label["service"], "fault": label["fault"]})
        base = min(label["baseline_windows"], inject_idx)   # collect() may have trimmed leading empty windows
        for m in METHODS:
            results[m].append(score_one(tel, label["service"], inject_idx, base, cfg, m))
    return _report(results, cfg, meta)


def run_synthetic(cfg: dict, runs: int = 10, seed: int = 0, hard: bool = False) -> dict:
    """SANITY CHECK ONLY: the generator encodes the method's own assumptions, so these numbers are
    never reported as evidence. They verify the pipeline runs and discriminates in a controlled case."""
    kw = dict(lag_range=(0, 1), root_mag=3.0, victim_mag=8.0) if hard else {}
    rng = np.random.default_rng(seed)
    roots = sorted({e for es in synthetic.CALLS.values() for e in es})
    results = {m: [] for m in METHODS}
    meta = []
    for i in range(runs):
        root = roots[int(rng.integers(len(roots)))]
        tel, truth = synthetic.make(root, seed=seed * 1000 + i, **kw)
        meta.append({"run": f"synthetic_{i}", "service": root, "fault": "synthetic"})
        for m in METHODS:
            results[m].append(score_one(tel, truth["service"], truth["onset"], truth["baseline"],
                                        cfg, m))
    return _report(results, cfg, meta)


def _git_commit() -> str:
    """Current commit hash read straight from .git (no process execution)."""
    try:
        git = Path(__file__).resolve().parent.parent / ".git"
        head = (git / "HEAD").read_text().strip()
        if head.startswith("ref:"):
            ref = head.split(" ", 1)[1]
            f = git / ref
            head = f.read_text().strip() if f.exists() else next(
                l.split()[0] for l in (git / "packed-refs").read_text().splitlines() if l.endswith(ref))
        return head[:8]
    except Exception:
        return "unknown"


def _report(results: dict, cfg: dict, meta: list[dict]) -> dict:
    k = cfg["experiment"]["top_k"]
    return {"n_runs": len(results[PROPOSED]),
            "metrics": {m: aggregate(rows, k) for m, rows in results.items()},
            "proposed_vs_others": compare(results),
            "per_run": {m: [{**mt, **r} for mt, r in zip(meta, rows)] for m, rows in results.items()},
            "provenance": {"git_commit": _git_commit(), "python": sys.version.split()[0],
                           "platform": platform.platform(), "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "detector": cfg["detector"], "cascade": cfg["cascade"]}}


def save(report: dict, out_root: Path, name: str) -> Path:
    """results/<name>/: summary.json, per_run.csv, table.tex (drop-in for the paper)."""
    out = out_root / name
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps({k: v for k, v in report.items() if k != "per_run"}, indent=2))
    with open(out / "per_run.csv", "w", newline="") as f:
        rows = [{"method": m, **r} for m, rs in report["per_run"].items() for r in rs]
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    ks = [c for c in next(iter(report["metrics"].values())) if c.startswith("A@")]
    lines = [r"\begin{tabular}{l" + "c" * (len(ks) + 2) + "}", r"\toprule",
             "Method & " + " & ".join(ks) + r" & MRR & $p_{\mathrm{Holm}}$ \\", r"\midrule"]
    for m, v in report["metrics"].items():
        cells = [f"{v[k]['mean']:.2f}" for k in ks] + [f"{v['MRR']['mean']:.2f} [{v['MRR']['ci95'][0]:.2f},{v['MRR']['ci95'][1]:.2f}]"]
        p = report["proposed_vs_others"].get(m, {}).get("p_holm")
        lines.append(f"{m.replace('_', ' ')} & " + " & ".join(cells) + f" & {'--' if p is None else f'{p:.3f}'} \\\\")
    lines += [r"\bottomrule", r"\end{tabular}"]
    (out / "table.tex").write_text("\n".join(lines))
    return out

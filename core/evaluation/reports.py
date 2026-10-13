"""The report's evidence, recomputed from code and data: the bench table and the real crash. Nothing is typed in by hand."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ..algo import attribute, flags_for, score
from ..preprocessing import prepare
from .bench import run

DATA = Path(__file__).resolve().parent.parent / "data"
JUDGE_SEEDS = list(range(3, 23))      # seeds 0-2 were used while developing the method; 3-22 are never tuned on

VARIANTS = {                          # name: (overrides to bench.run, what it shows) -- the report's sections 6 and 8
    "ours (report method)": ({}, "the full method"),
    "most abnormal": (dict(method="most_abnormal"), "baseline: highest score wins, no explain-away"),
    "earliest": (dict(method="earliest"), "baseline: first service to alarm"),
    "original notebook": (dict(method="original"), "baseline: whole-dataset z > 3, rank by count"),
    "random": (dict(method="random"), "lower bound"),
    "no silence signal": (dict(silence_k=0), "ablation"),
    "no per-series normalisation": (dict(per_series=False), "ablation"),
    "no explain-away (gamma 0)": (dict(gamma=0.0), "ablation"),
    "no crash bonus": (dict(hard=False), "ablation"),
}


def bench_table(seeds=JUDGE_SEEDS, variants=VARIANTS, progress=None) -> list[dict]:
    """Accuracy of every method and ablation on the judging seeds: A@1, A@3, MRR, recall, per-fault-type A@1, false alarms per hour.
    The A@1 interval is a seed-cluster bootstrap: faults inside one seed share the same background traffic, so they are not independent."""
    rows, done = [], 0
    for name, (over, why) in variants.items():
        Rs, fa = [], []
        for sd in seeds:
            summ, R = run(over, seed=sd)
            Rs.append(R.assign(seed=sd)); fa.append(summ["false_alarms_h"]); done += 1
            if progress:
                progress(done, len(variants) * len(seeds))
        R = pd.concat(Rs)
        per_seed = R.groupby("seed").A1.agg(["sum", "count"]).to_numpy()
        rng = np.random.default_rng(0)
        boot = [per_seed[i].sum(0) for i in (rng.integers(0, len(per_seed), len(per_seed)) for _ in range(2000))]
        ci = np.percentile([b[0] / b[1] for b in boot], [2.5, 97.5])
        by_kind = R.groupby("kind").A1.mean()
        rows.append({"variant": name, "why": why, "faults": int(len(R)), "A1": float(R.A1.mean()), "A1_ci": [float(ci[0]), float(ci[1])],
                     "A3": float(R.A3.mean()), "MRR": float((1 / R["rank"]).mean()), "recall": float(R.recall.mean()),
                     "false_alarms_h": float(np.mean(fa)), **{f"A1_{k}": float(v) for k, v in by_kind.items()}})
    return rows


def deathstar_call_graph() -> list[tuple[str, str]]:
    """The DeathStarBench social network's call graph, written by hand from its source (the compose file only gives start order)."""
    return [tuple(e) for e in json.loads((DATA / "deathstar_call_graph.json").read_text())]


def real_crash() -> dict:
    """The one real fault: DeathStarBench on AWS, post-storage-service stopped for ~2 minutes (docker stop). SSH data only.
    Returns the prepared panel, scores, flags, the ledger and the rank the method gave the stopped container."""
    ev = json.loads((DATA / "ssh_crash_events.json").read_text())
    rows = []
    for line in (DATA / "death-star-crash.jsonl").read_text().splitlines():
        r = json.loads(line)
        for n, v in r["svc"].items():
            rows.append(dict(timestamp=pd.Timestamp(r["t"], unit="s", tz="UTC"), service=n, cpu_percent=v["cpu"], memory_usage_mb=v["mem"] / 1e6,
                             network_rx_bytes=v["rx"], network_tx_bytes=v["tx"], error_count=np.nan if v["err"] is None else v["err"]))
    p = prepare(pd.DataFrame(rows), step=10, track_presence=True, edges=deathstar_call_graph())
    sc = score(p, window=30, min_base=8, silence_k=6)
    a = int(np.searchsorted(p.times, ev["t_stop"])); b = int(np.searchsorted(p.times, ev["t_start"]))
    tau = 6.0
    fl = flags_for(sc, tau, 2)
    att = attribute(p, sc, (a - 2, b + 1))
    return dict(panel=p, scores=sc, flags=fl, tau=tau, attribution=att, container=ev["container"], stop=a, restart=b,
                seconds=round(ev["t_start"] - ev["t_stop"]), rank=int(np.flatnonzero(att.service == ev["container"])[0]) + 1,
                false_flags_before=int(fl[:a - 2].sum()))

"""Command line: python -m rcalab <command>"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from . import config, evaluate, projects, store
from .detector import detect
from .explain import explain
from .rca import rank


def _emit(report: dict, name: str):
    out = evaluate.save(report, Path("results"), name)
    print(f"{'method':15}{'A@1':>6}{'A@3':>6}{'MRR':>6}  p_holm (proposed vs method)")
    for m, v in report["metrics"].items():
        p = report["proposed_vs_others"].get(m, {}).get("p_holm")
        print(f"{m:15}{v['A@1']['mean']:6.2f}{v['A@3']['mean']:6.2f}{v['MRR']['mean']:6.2f}  "
              f"{'' if p is None else f'{p:.3f}'}")
    print(f"saved {out} (summary.json, per_run.csv, table.tex)")


def main():
    ap = argparse.ArgumentParser(prog="rcalab")
    ap.add_argument("--config", help="path to a config file (default: the active project)")
    ap.add_argument("--project", help="saved project name (see `projects`)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create config.yaml, prompting for required values")
    sub.add_parser("projects", help="list saved projects")
    sub.add_parser("check", help="list config values still missing")
    p = sub.add_parser("diagnose", help="analyse the last N minutes of live telemetry")
    p.add_argument("--minutes", type=int, default=20)
    p = sub.add_parser("record", help="collect a labelled run for a fault you injected elsewhere")
    p.add_argument("--service", required=True, help="service the fault was injected into")
    p.add_argument("--fault", required=True, help="free-text fault name, e.g. flagd:cartFailure")
    p.add_argument("--start", required=True, help="injection start (ISO time or unix seconds)")
    p.add_argument("--end", required=True, help="injection end (ISO time or unix seconds)")
    p.add_argument("--out", default="runs")
    p = sub.add_parser("evaluate", help="score saved runs (or --synthetic) against labels")
    p.add_argument("--runs-dir", default="runs")
    p.add_argument("--synthetic", action="store_true")
    p.add_argument("--hard", action="store_true", help="synthetic: victims louder than the root")
    a = ap.parse_args()

    if a.cmd == "projects":
        act = projects.active()
        for p in projects.listing():
            print(f"{'*' if p['name'] == act else ' '} {p['name']:20} {p['mode']:6} {p['summary']}"
                  + (f"  (missing: {', '.join(p['missing'])})" if p["missing"] else ""))
        return
    if a.cmd == "init":
        cfg = config.init(out=a.config or "config.yaml")
        print(f"wrote {a.config or 'config.yaml'}; still missing: {config.missing(cfg) or 'nothing'}")
        return
    if a.cmd == "evaluate" and a.synthetic:
        cfg = config.load(a.config) if a.config and Path(a.config).exists() else config.load("config.example.yaml")
        _emit(evaluate.run_synthetic(cfg, hard=a.hard), "synthetic_sanity" + ("_hard" if a.hard else ""))
        return

    if a.config:
        cfg = config.load(a.config)
    elif a.project or projects.active():
        cfg = projects.load(a.project or projects.active())
    else:
        cfg = config.load("config.yaml")
    if a.cmd == "check":
        gaps = config.missing(cfg)
        print("config complete" if not gaps else "missing:\n  " + "\n  ".join(gaps))
        return
    config.require_complete(cfg)

    if a.cmd == "diagnose":
        from .collect import collect
        step = cfg["collection"]["step_seconds"]
        end = time.time()
        tel = collect(cfg, end - a.minutes * 60, end)
        base = cfg["collection"]["baseline_minutes"] * 60 // step
        det = detect(tel, base, cfg["detector"]["z_threshold"], kind=cfg["detector"]["kind"])
        window = (base, len(tel.times))
        res = rank(tel, det, window, cfg["cascade"]["max_lag_windows"], cfg["cascade"]["max_hops"])
        print(explain(tel, det, res, window))
    elif a.cmd == "record":
        from .record import record
        n = len([d for d in Path(a.out).glob("run_*")]) if Path(a.out).exists() else 0
        d = record(cfg, a.service, a.fault, a.start, a.end, Path(a.out) / f"run_{n:02d}_{a.service}")
        print(f"saved {d}")
    elif a.cmd == "evaluate":
        _emit(evaluate.run_dir(cfg, Path(a.runs_dir)), "live_" + time.strftime("%Y%m%d_%H%M%S"))


if __name__ == "__main__":
    main()

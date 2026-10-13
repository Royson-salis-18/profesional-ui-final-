"""Dashboard backend.  Run:  python server.py   then open http://localhost:8000
Serves results computed from telemetry (synthetic demo, or a saved project's live data via tools and/or SSH).
"""
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from rcalab import collect as collector
from rcalab import config, core, ec2import, evaluate, projects, synthetic
from rcalab.cascade import cascade_risk, edge_probabilities, path_probabilities
from rcalab.detector import calibrate_threshold, detect
from rcalab.explain import explain, suspects
from rcalab.rca import rank
from rcalab.sources import ssh as sshsrc

ROOT = Path(__file__).parent
import logging
logging.getLogger("paramiko").setLevel(logging.CRITICAL)   # an unreachable host would print a traceback every poll; the sampler records the error itself
app = FastAPI()
projects.migrate_legacy()

_live: dict[str, dict] = {}          # per project: {"tel", "at", "minutes"}
_samplers: dict[str, dict] = {}      # per project: {"obj", "key"}


def cfg() -> dict:
    """Config of the active project (or the template when there are no projects yet)."""
    a = projects.active()
    return projects.load(a) if a else config.load(projects.TEMPLATE)


def _stop_sampler(name: str):
    s = _samplers.pop(name, None)
    if s and s["obj"]:
        s["obj"].stop()


def _ensure_sampler(name: str, c: dict):
    """ssh/both projects keep a background sampler polling their host; restart it if the target changes."""
    if collector.mode(c) == "tools" or config.missing(c):
        return _stop_sampler(name)
    key = (c["ssh"]["host"], c["ssh"]["key_path"], c["ssh"].get("user"), c["collection"]["step_seconds"])
    if _samplers.get(name, {}).get("key") != key:
        _stop_sampler(name)
        s = sshsrc.Sampler(collector.ssh_source(c), collector.sample_path(c), c["collection"]["step_seconds"])
        s.start()
        _samplers[name] = {"obj": s, "key": key}


def _ensure_all_samplers():
    for n in projects.names():
        try:
            _ensure_sampler(n, projects.load(n))
        except Exception as e:
            print(f"[sampler] {n}: {e}")


@lru_cache(maxsize=32)
def _demo(root: str, hard: bool, z: float):
    kw = dict(lag_range=(0, 1), root_mag=3.0, victim_mag=8.0) if hard else {}
    tel, truth = synthetic.make(root, **kw)
    return tel, detect(tel, truth["baseline"], z), truth["baseline"], truth["onset"]


def _live_data(minutes: int, z: float, refresh: bool):
    """Live telemetry of the active project. First call pulls the whole window; refreshes (only when
    following the latest window) re-read just the new windows (tools) or the sample file (ssh)."""
    name, c = projects.active(), cfg()
    if name is None:
        raise ValueError("No project yet. Click the project menu, then New project.")
    if config.missing(c):
        raise ValueError(f"Project '{name}' is incomplete. Missing: " + ", ".join(config.missing(c)))
    _ensure_sampler(name, c)
    st = _live.setdefault(name, {"tel": None, "at": 0.0, "minutes": None})
    step = c["collection"]["step_seconds"]
    now = time.time()
    incremental = collector.mode(c) != "ssh"
    if st["tel"] is None or st["minutes"] != minutes or (refresh and not incremental and now - st["at"] > 10):
        st.update(tel=collector.collect(c, now - minutes * 60, now), at=now, minutes=minutes)
    elif refresh and now - st["at"] > 10:
        new = collector.collect(c, st["tel"].times[-1] - 2 * step, now, trim_leading=False, services=st["tel"].services)
        st.update(tel=collector.merge(st["tel"], new, keep=minutes * 60 // step), at=now)
    tel = st["tel"]
    base = min(c["collection"]["baseline_minutes"] * 60 // step, max(len(tel.times) // 2, 1))
    d = c["detector"]
    if d.get("kind") == "calibrated":
        cal = int(max(min(d.get("calibration_windows", 100), len(tel.times) - base - 10), 10))
        tau = calibrate_threshold(tel, base, cal, float(d.get("alarm_budget_per_hour", 5)), persistence=int(d.get("persistence", 3)))
        st["tau"] = tau
        return tel, detect(tel, base, tau, persistence=int(d.get("persistence", 3)), kind="calibrated"), base, None
    return tel, detect(tel, base, z, kind=d["kind"]), base, None


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/meta")
def meta():
    c = cfg()
    return {"demo_services": sorted({e for es in synthetic.CALLS.values() for e in es}),
            "z": c["detector"]["z_threshold"], "mode": collector.mode(c), "active": projects.active()}


@app.get("/api/state")
def state(source: str = "demo", root: str = "cart-db", hard: bool = True, z: float = 3.5,
          method: str = "full", t: int = -1, minutes: int = 20, seed: int = 3):
    if source in ("bench", "crash") or (source == "live" and method == "core"):
        try:
            return _core_state(source, t, minutes, seed)
        except Exception as e:  # surfaced in the UI
            return {"error": str(e)}
    return _classic_state(source, root, hard, z, method, t, minutes)


def _core_state(source: str, t: int, minutes: int, seed: int, view: int = 240):
    """The report's method (rcalab/core.py) on the bench or on live data, shaped like the classic payload plus:
    offset (index of the first tick shown), ledger faults in view, the fault active at t and whether the ranking got it right."""
    ledger, R = [], None
    if source == "bench":
        _, p, ledger, sc, tau, fl, R = core.bench_state(seed)
    elif source == "crash":
        _, p, ledger, sc, tau, fl, R = core.crash_state()
    else:
        tel, *_ = _live_data(minutes, 3.5, refresh=(t < 0))
        p = core.panel_from_telemetry(tel)
        sc, tau, fl = core.live_detect(p)
    T = len(p.times)
    t = T - 1 if t < 0 else min(max(t, 0), T - 1)
    off = max(0, t - view + 1) if source == "bench" else 0
    win = core.alarm_window(fl, t)
    att = core.attribute(p, sc, win) if win else None
    at_risk = core.risk(p, sc, fl, t, tau) if p.edges else {}
    idx = {s_: i for i, s_ in enumerate(p.services)}
    sus, text = [], "No alarm in this window: no service stayed above the calibrated threshold, so no root-cause ranking is run."
    if att is not None:
        a, b = win
        top = max(float(att.score.iloc[0]), 1e-9)
        callers = core.callers_of(p.edges)
        for _, r in att.head(5).iterrows():
            i = idx[r.service]
            fz = sc.z[a:b, i].max(axis=0)
            feats = [{"name": sc.features[k], "z": float(fz[k])} for k in np.argsort(-fz)[:3] if fz[k] > 0]
            victims = [{"service": c, "p": None} for c in callers.get(r.service, []) if sc.zs[a:b, idx[c]].max() >= tau]
            sus.append({"service": r.service, "score": float(r.score), "rel": float(max(r.score, 0) / top), "onset_window": int(a),
                        "features": feats, "impacted": victims, "own": float(r.own), "symptoms": float(r.symptoms),
                        "explained": float(r.explained), "note": r.note})
        text = "\n".join(f"#{k + 1} {r.service}: score {r.score:.1f} = max(own {r.own:.1f}, symptoms {r.symptoms:.1f} - explained "
                         f"{r.explained:.1f}){' · ' + r.note if r.note else ''}" for k, r in att.head(5).iterrows())
    truth = None
    for f in ledger:                                            # the fault whose (ledger + 4 ticks) window contains t
        if f["a"] <= t <= f["b"] + 4:
            rank_ = (list(att.service).index(f["root"]) + 1) if att is not None else None
            truth = {"root": f["root"], "kind": f["kind"], "a": f["a"] - off, "b": f["b"] - off, "rank_now": rank_}
    flt = [{"root": f["root"], "kind": f["kind"], "a": f["a"] - off, "b": f["b"] - off,
            "rank": int(R.iloc[k]["rank"]) if R is not None else None, "abs_a": f["a"]}
           for k, f in enumerate(ledger) if f["b"] >= off and f["a"] <= t]
    heat = np.minimum(sc.zs[off:t + 1], 20).T
    # PREDICT: healthy services at risk now; in a replay the future is known, so check whether they really alarmed next
    horizon = 8                                                    # ticks: 2 min at 15 s, 80 s at 10 s
    risky = sorted(((s_, float(r_)) for s_, r_ in dict(at_risk).items() if r_ >= 0.15 and not fl[t, idx[s_]]), key=lambda x: -x[1])[:3]
    predict = [{"service": s_, "risk": r_, "later": (bool(fl[t + 1:t + 1 + horizon, idx[s_]].any()) if source != "live" and t + 1 < T else None)}
               for s_, r_ in risky]
    if source == "bench":
        map_src = "from Jaeger traces"
    elif source == "crash":
        map_src = "hand-written from DeathStarBench source"
    else:
        c_ = cfg(); m_ = collector.mode(c_); ss_ = c_.get("ssh", {})
        map_src = ("from Jaeger traces" if m_ != "ssh" else
                   " + ".join(x for x in ("compose file" if ss_.get("compose_file") else "", "hand-written list" if ss_.get("extra_edges") else "") if x)
                   or "none yet: add a compose file to the project")
    return {
        "T": t + 1 - off, "t": t - off, "offset": off, "T_total": T, "baseline": max(0, (8 if source == "crash" else core.LIVE_KW["min_base"]) - off),
        "onset": None, "time": float(p.times[t]), "method": "core", "seed": seed if source == "bench" else None,
        "nodes": [{"id": s_, "z": float(sc.zs[t, i]), "risk": float(at_risk.get(s_, 0.0)), "flag": bool(fl[t, i]),
                   "score": float(att.set_index("service").score.get(s_, 0.0)) if att is not None else 0.0}
                  for i, s_ in enumerate(p.services)],
        "edges": [{"source": e, "target": c, "p": 0.5, "hot": bool(fl[t, idx[e]])} for c, e in p.edges],
        "ranking": [{"service": r.service, "score": float(r.score)} for _, r in att.head(10).iterrows()] if att is not None else [],
        "explanation": text, "suspects": sus, "services": p.services,
        "heat": [[round(float(v), 2) for v in row] for row in np.nan_to_num(heat)],
        "step_s": float(p.step), "z_threshold": float(tau), "ledger": flt, "truth": truth, "predict": predict, "horizon_s": horizon * float(p.step),
        "alarm": {"start": win[0] - off, "start_abs": win[0], "time": float(p.times[win[0]])} if win else None,
        "map": {"services": len(p.services), "links": len(p.edges), "source": map_src}, "truth_a_abs": None if truth is None else truth["a"] + off,
        "all_faults": [{"root": f["root"], "kind": f["kind"], "a": f["a"], "b": f["b"], "rank": int(R.iloc[k]["rank"])} for k, f in enumerate(ledger)] if R is not None else [],
    }


def _classic_state(source, root, hard, z, method, t, minutes):
    try:
        tel, det, base, onset = _demo(root, hard, z) if source == "demo" else _live_data(minutes, z, refresh=(t < 0))
    except Exception as e:  # surfaced in the UI
        return {"error": str(e)}
    c = cfg()
    T = len(tel.times)
    t = T - 1 if t < 0 else min(t, T - 1)
    lag, hops = c["cascade"]["max_lag_windows"], c["cascade"]["max_hops"]

    probs = edge_probabilities(tel, det.flags[: t + 1], lag)
    P = path_probabilities(tel.services, probs, hops)
    risk = cascade_risk(det.a[t], P)

    ranking, text, sus = [], "Baseline period: collecting normal behaviour.", []
    two_stage = source != "demo" and c["detector"].get("kind") == "calibrated"
    if two_stage and t > base and not det.flags[base:t + 1].any():
        text = "No alarm in this window: nothing exceeds the calibrated alarm threshold, so no root-cause ranking is run."
    elif t > base:
        det_rca = det
        if source != "demo" and c["detector"].get("kind") == "calibrated":   # two-stage: strict alarm, lower threshold for candidates
            det_rca = detect(tel, base, float(c["detector"].get("candidate_threshold", 3.5)), persistence=2, kind="calibrated")
        res = rank(tel, det_rca, (base, t + 1), lag, hops, method)
        ranking = [{"service": s, "score": float(v)} for s, v in res.ranking]
        text = explain(tel, det_rca, res, (base, t + 1))
        sus = suspects(tel, det_rca, res, (base, t + 1))
    score = {r["service"]: r["score"] for r in ranking}

    return {
        "T": T, "t": t, "baseline": base, "onset": onset, "time": float(tel.times[t]),
        "nodes": [{"id": s, "z": float(det.z[t, i]), "risk": float(risk[i]), "flag": bool(det.flags[t, i]),
                   "score": score.get(s, 0.0)} for i, s in enumerate(tel.services)],
        "edges": [{"source": callee, "target": caller, "p": float(p),
                   "hot": bool(det.flags[t, tel.index(callee)])} for (callee, caller), p in probs.items()],
        "ranking": ranking, "explanation": text, "suspects": sus, "services": tel.services,
        "heat": [[round(float(v), 2) for v in row] for row in np.nan_to_num(np.minimum(det.z, 20)).T],
        "step_s": float(tel.times[1] - tel.times[0]),
        "series": [float(x) for x in np.nan_to_num(np.minimum(det.z.max(axis=1), 20))],
        "z_threshold": (_live.get(projects.active() or "", {}).get("tau", z) if source != "demo" else z),
    }


# ---------------- experiments (the report's evidence, recomputed here) ----------------
BENCH_VARIANTS = {   # name: (overrides, what it shows) -- the report's sections 6 and 8
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
JUDGE_SEEDS = list(range(3, 23))     # the report's 20 judging seeds; 0-2 were used for tuning
_bench_job = {"running": False, "done": 0, "total": 0, "rows": None, "error": None}
BENCH_CACHE = ROOT / "results" / "lab_bench_eval.json"      # computed once, kept across restarts (delete it to recompute)


def _json_dumps(o):
    import json as _j
    return _j.dumps(o, indent=1)


if BENCH_CACHE.exists():
    try:
        import json as _j
        _bench_job["rows"] = _j.loads(BENCH_CACHE.read_text())["rows"]
    except Exception:
        pass


def _bench_eval_worker():
    import pandas as pd
    job = _bench_job
    try:
        rows = []
        job.update(done=0, total=len(BENCH_VARIANTS) * len(JUDGE_SEEDS))
        for name, (over, why) in BENCH_VARIANTS.items():
            Rs, fa = [], []
            for sd in JUDGE_SEEDS:
                summ, R = core.run(over, seed=sd)
                Rs.append(R.assign(seed=sd)); fa.append(summ["false_alarms_h"]); job["done"] += 1
            R = pd.concat(Rs)
            per_seed = R.groupby("seed").A1.agg(["sum", "count"]).to_numpy()
            rng = np.random.default_rng(0)                    # seed-cluster bootstrap: faults in one seed are not independent
            boot = [per_seed[i].sum(0) for i in (rng.integers(0, len(per_seed), len(per_seed)) for _ in range(2000))]
            ci = np.percentile([b[0] / b[1] for b in boot], [2.5, 97.5])
            k = R.groupby("kind").A1.mean()
            rows.append({"variant": name, "why": why, "faults": int(len(R)), "A1": float(R.A1.mean()), "A1_ci": [float(ci[0]), float(ci[1])],
                         "A3": float(R.A3.mean()), "MRR": float((1 / R["rank"]).mean()), "recall": float(R.recall.mean()),
                         "false_alarms_h": float(np.mean(fa)), **{f"A1_{kk}": float(v) for kk, v in k.items()}})
        job["rows"] = rows
        BENCH_CACHE.parent.mkdir(exist_ok=True)
        BENCH_CACHE.write_text(_json_dumps({"rows": rows, "seeds": JUDGE_SEEDS}))
    except Exception as e:
        job["error"] = str(e)
    finally:
        job["running"] = False


@app.get("/api/bench/eval")
def bench_eval(start: bool = False):
    """The report's bench table, recomputed in this process on seeds 3-22. start=true kicks it off (about a minute)."""
    import threading
    if start and not _bench_job["running"] and _bench_job["rows"] is None:
        _bench_job.update(running=True, error=None)
        threading.Thread(target=_bench_eval_worker, daemon=True).start()
    return {**_bench_job, "seeds": JUDGE_SEEDS}


@app.get("/api/bench/faults")
def bench_faults(seed: int = 3):
    _, p, ledger, _, tau, _, R = core.bench_state(seed)
    return {"seed": seed, "tau": tau, "step_s": p.step, "faults": [{**f, "rank": int(R.iloc[k]["rank"]), "recall": bool(R.iloc[k]["recall"])}
                                                                    for k, f in enumerate(ledger)]}


@app.get("/api/experiments")
def experiments():
    """Saved real-fault results, labelled with how much they can be trusted."""
    import json as _json
    out = {"report": (ROOT / "docs" / "RCA_STATISTICAL_REPORT.html").exists()}
    core.crash_state()
    c = core._CRASH
    out["crash"] = {"host": "death-star", "service": c["ledger"][0]["root"], "seconds": c["seconds"], "rank": int(c["R"].iloc[0]["rank"]),
                    "of": len(c["p"].services), "false_flags_before": c["false_flags_before"],
                    "note": "recomputed now from samples/death-star-crash.jsonl with the report method; n = 1, a demonstration"}
    try:
        lp = _json.loads((ROOT / "docs/experiments/live_pause_results.json").read_text())
        out["pause"] = {"host": lp["host"], "faults": [{"service": f["service"], "seconds": f["seconds"], "user_error_rate": f["user_error_rate"]}
                                                      for f in lp["faults"]],
                        "after_fixes": lp.get("after_fixes_same_data"), "false_alarms_h": lp.get("false_alarm_episodes_per_h"),
                        "note": "frozen services are detected but not localised; fixes were developed on this same run"}
    except Exception:
        out["pause"] = None
    try:
        fx = _json.loads((ROOT / "docs/experiments/fixes_results.json").read_text())["A_false_alarms"]
        out["false_alarms"] = {"hours": fx["test_hours"], "before": fx["old robust-z 3.5, persist 2"]["episodes_per_hour"],
                               "after": fx["calibrated, target 1/h"]["episodes_per_hour"],
                               "note": "real healthy OTel traffic; old detector vs the calibrated one"}
    except Exception:
        out["false_alarms"] = None
    return out


@app.get("/report")
def report():
    f = ROOT / "docs" / "RCA_STATISTICAL_REPORT.html"
    return FileResponse(f) if f.exists() else {"error": "docs/RCA_STATISTICAL_REPORT.html not found"}


@app.get("/api/eval")
def run_eval(source: str = "demo"):
    c = cfg()
    return evaluate.run_synthetic(c, runs=10, hard=True) if source == "demo" else evaluate.run_dir(c, ROOT / "runs")


# ---------------- projects ----------------
class ProjectIn(BaseModel):
    original_name: str = ""            # set when editing/renaming an existing project
    mode: str = "tools"
    system_name: str = ""
    services: str = ""
    jaeger_url: str = ""
    jaeger_entry: str = ""
    prometheus_url: str = ""
    loki_url: str = ""
    ssh_host: str = ""
    ssh_user: str = "ubuntu"
    ssh_port: int = 22
    ssh_key_path: str = ""
    ssh_compose_file: str = ""
    step_seconds: int = 15
    baseline_minutes: int = 10


@app.get("/api/projects")
def list_projects():
    rows = projects.listing()
    for r in rows:
        r["sampler_error"] = (_samplers.get(r["name"], {}).get("obj").last_error if r["name"] in _samplers else None)
    return {"active": projects.active(), "projects": rows}


@app.get("/api/projects/{name}")
def get_project(name: str):
    try:
        c = projects.load(name)
    except Exception:
        return {"error": f"no project named {name}"}
    return {**projects.to_form(c), "missing": config.missing(c)}


@app.post("/api/projects")
def save_project(b: ProjectIn):
    if not b.system_name.strip():
        return {"error": "Give the project a name."}
    try:
        base = projects.load(b.original_name) if b.original_name else None
        c = projects.from_form(b.model_dump(), base)
        new = projects.slug(b.system_name)
        if new != projects.slug(b.original_name) and new in projects.names():
            return {"error": f"A project named '{new}' already exists."}
        name = projects.save(c)
        if b.original_name and projects.slug(b.original_name) != name:
            _stop_sampler(projects.slug(b.original_name)); _live.pop(projects.slug(b.original_name), None)
            projects.delete(b.original_name)
        projects.set_active(name)
        _live.pop(name, None)
        _ensure_sampler(name, c)
    except Exception as e:
        return {"error": str(e)}
    return {"ok": True, "name": name, "missing": config.missing(c)}


class Ec2Import(BaseModel):
    text: str
    key_dir: str = "~/Downloads"
    key_path: str = ""


@app.post("/api/projects/import-ec2")
def import_ec2(b: Ec2Import):
    """Paste of the EC2 console's instance table -> projects linked to the instances' current IPs."""
    try:
        r = ec2import.apply(b.text, b.key_dir, b.key_path)
    except Exception as e:
        return {"error": str(e)}
    for row in r.get("instances", []):          # a changed host means stale cached telemetry and sampler
        if row.get("changes") and row.get("project"):
            _stop_sampler(row["project"]); _live.pop(row["project"], None)
    return r


@app.post("/api/projects/{name}/select")
def select_project(name: str):
    try:
        projects.set_active(name)
    except KeyError:
        return {"error": f"no project named {name}"}
    return {"ok": True, "active": projects.active()}


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    _stop_sampler(projects.slug(name)); _live.pop(projects.slug(name), None)
    projects.delete(name)
    return {"ok": True, "active": projects.active()}


@app.post("/api/projects/{name}/test")
def test_project(name: str):
    """Check each source of a project separately so you can see which one is not reachable."""
    try:
        c = projects.load(name)
    except Exception:
        return {"error": f"no project named {name}"}
    out, m = [], collector.mode(c)

    def check(source, fn):
        t = time.time()
        try:
            out.append({"source": source, "ok": True, "detail": fn(), "ms": int((time.time() - t) * 1000)})
        except Exception as e:
            out.append({"source": source, "ok": False, "detail": (str(e) or type(e).__name__)[:200], "ms": int((time.time() - t) * 1000)})

    if m in ("tools", "both"):
        from rcalab.sources import jaeger, loki, prometheus
        s = c["sources"]
        if s["jaeger"]["url"] not in ("", "REQUIRED"):
            check("jaeger", lambda: f"{len(jaeger.services(s['jaeger']['url']))} services")
        else:
            out.append({"source": "jaeger", "ok": False, "detail": "URL not set", "ms": 0})
        if s["prometheus"].get("url"):
            check("prometheus", lambda: f"{len(prometheus.query_range(s['prometheus']['url'], 'vector(1)', time.time() - 60, time.time(), 15))} points")
        if s.get("loki", {}).get("url"):
            check("loki", lambda: f"{loki.query_range(s['loki']['url'], 'vector(1)', time.time() - 60, time.time(), 15).size} points")
    if m in ("ssh", "both"):
        if any(k.startswith("ssh.") for k in config.missing(c)):
            out.append({"source": "ssh", "ok": False, "detail": "host / key file not set", "ms": 0})
        else:
            check("ssh", lambda: f"{len(collector.ssh_source(c).containers())} running containers (read-only docker ps)")
    return {"mode": m, "results": out}


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

if __name__ == "__main__":
    _ensure_all_samplers()
    uvicorn.run(app, host="127.0.0.1", port=8000)

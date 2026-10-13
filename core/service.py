"""The core as a small HTTP service (port 8000): live incidents for the graph service/UI, and the evaluation evidence.

    GET /api/core/health             collector status, per-target sample counts
    GET /api/core/incidents          incidents for all targets (or ?targetId=)
    GET /api/core/evaluation         the bench table (computed once in the background, then cached)
    GET /api/core/real-crash         the real DeathStar crash replay result

Run:  python -m core.service        (needs the graph service on CORE_NODE_URL, default http://localhost:3001)
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from typing import Optional

from fastapi import FastAPI

from . import incidents
from .live import NODE_URL, LiveCollector

app = FastAPI(title="rca core")
collector = LiveCollector(persist=os.environ.get("CORE_PERSIST", "1") != "0")
CACHE = Path(__file__).resolve().parent / "data" / "evaluation_cache.json"
_job = {"running": False, "done": 0, "total": 0, "rows": None, "error": None}


@app.on_event("startup")
def _start():
    collector.start()
    if CACHE.exists():
        try:
            _job["rows"] = json.loads(CACHE.read_text())["rows"]
        except Exception:
            pass


@app.get("/api/core/health")
def health():
    return {"ok": True, "graph_service": NODE_URL, **collector.status,
            "targets": {t: {"samples": len(collector.rows[t]), "edges": len(collector.edges.get(t, []))} for t in collector.targets()}}


@app.get("/api/core/incidents")
def get_incidents(targetId: Optional[str] = None):
    out = []
    for t in ([targetId] if targetId else collector.targets()):
        inc = incidents.build_incident(collector.analyse(t))
        if inc:
            out.append(inc)
    return out


@app.get("/api/core/analysis")
def analysis():
    """What the graph service asks for: the incidents, plus which targets the core has enough history to judge (warm-up is not 'healthy')."""
    ready, out = {}, []
    for t in collector.targets():
        a = collector.analyse(t)
        ready[t] = a is not None
        inc = incidents.build_incident(a)
        if inc:
            out.append(inc)
    return {"ready": ready, "incidents": out}


def _bench_worker():
    from .evaluation.reports import bench_table
    try:
        def prog(d, n):
            _job.update(done=d, total=n)
        rows = bench_table(progress=prog)
        _job["rows"] = rows
        CACHE.write_text(json.dumps({"rows": rows}, indent=1))
    except Exception as e:
        _job["error"] = str(e)
    finally:
        _job["running"] = False


@app.get("/api/core/evaluation")
def evaluation(start: bool = False):
    if start and not _job["running"] and _job["rows"] is None:
        _job.update(running=True, error=None)
        threading.Thread(target=_bench_worker, daemon=True).start()
    return _job


@app.get("/api/core/real-crash")
def real_crash():
    from .evaluation.reports import real_crash as rc
    c = rc()
    return {"service": c["container"], "seconds": c["seconds"], "rank": c["rank"], "of": len(c["panel"].services),
            "false_flags_before": c["false_flags_before"], "n": 1,
            "note": "one real fault, the easiest type (a stopped container): a demonstration, not a statistic"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

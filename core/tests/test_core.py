"""The core must reproduce the statistical report, and the graph helpers must stay honest."""
import numpy as np

from core.algo import attribute, callers_of, compose_edges, edges_from_graph, merge_edges
from core.evaluation import bench, reports
from core.preprocessing import prepare


def test_bench_seed3_matches_report():
    s, R = bench.run(seed=3)
    assert s["tau"] == 3.25 and s["faults"] == 38                      # report: "alarm line tau = 3.25"
    assert R.groupby("kind").A1.mean()["crash"] == 1.0


def test_report_example_product_catalog_crash():
    clean, p, ledger = bench.make_bench(3)
    sc = bench.score(p); tau = 3.25
    f = ledger[1]                                                    # report section A5: seed 3, fault #2
    assert (f["root"], f["kind"]) == ("product-catalog", "crash")
    from core.algo import normalise, flags_for
    scn = normalise(sc, bench.score(clean))
    att = attribute(p, scn, (f["a"], f["b"] + 4))
    assert att.service[0] == "product-catalog" and att.score[0] >= 100


def test_judging_seeds_headline_numbers():
    rows = reports.bench_table(variants={"ours": reports.VARIANTS["ours (report method)"]})
    r = rows[0]
    assert r["faults"] == 751
    assert abs(r["A1"] - 0.695) < 0.002 and abs(r["A3"] - 0.768) < 0.002      # report: 69.5% / 76.8%
    assert r["A1_crash"] == 1.0 and r["A1_hang"] == 1.0
    assert 0.1 < r["false_alarms_h"] < 0.25                                      # report: 0.15/h (pooled); 0.17 averaged per seed


def test_real_crash_root_ranked_first():
    c = reports.real_crash()
    assert c["rank"] == 1 and c["false_flags_before"] == 0 and len(c["panel"].services) == 27


def test_compose_edges_reads_depends_on():
    text = "services:\n  web:\n    depends_on: [api]\n  api:\n    depends_on:\n      db:\n        condition: service_started\n  db: {}\n"
    assert compose_edges(text) == [("api", "db"), ("web", "api")]


def test_edges_from_graph_uses_names_and_can_require_observation():
    g = {"nodes": [{"id": "p:a", "name": "a"}, {"id": "p:b", "name": "b"}, {"id": "p:c", "name": "c"}],
         "edges": [{"source": "p:a", "target": "p:b", "observed": True}, {"source": "p:b", "target": "p:c", "observed": False, "evidenceSources": ["compose-config"]}]}
    assert edges_from_graph(g) == [("a", "b"), ("b", "c")]
    assert edges_from_graph(g, observed_only=True) == [("a", "b")]
    assert merge_edges([("a", "b")], [("a", "b"), ("b", "b"), ("c", "a")]) == [("a", "b"), ("c", "a")]
    assert callers_of([("a", "b"), ("c", "b")]) == {"b": ["a", "c"]}


def test_prepare_marks_a_vanished_container_down():
    import pandas as pd
    rows = []
    for t in range(0, 300, 10):
        rows.append(dict(timestamp=pd.Timestamp(1_700_000_000 + t, unit="s", tz="UTC"), service="db", cpu_percent=5.0, memory_usage_mb=100.0))
        if t < 150:
            rows.append(dict(timestamp=pd.Timestamp(1_700_000_000 + t, unit="s", tz="UTC"), service="api", cpu_percent=5.0, memory_usage_mb=100.0))
    p = prepare(pd.DataFrame(rows), step=10)
    k = p.features.index("container_up"); j = p.services.index("api")
    assert p.X[5, j, k] == 1.0 and p.X[20, j, k] == 0.0              # present early, gone later while db still reports


def test_algo_is_pure():
    """core/algo.py is the algorithm file: numbers in, numbers out. No files, network, processes, plotting or web framework."""
    import ast
    from pathlib import Path
    tree = ast.parse((Path(__file__).resolve().parent.parent / "algo.py").read_text())
    imported = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            imported |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.level == 0:
            imported.add((n.module or "").split(".")[0])
    forbidden = {"os", "sys", "socket", "urllib", "http", "requests", "subprocess", "threading", "pathlib", "json", "fastapi", "uvicorn",
                 "matplotlib", "paramiko", "sklearn", "joblib", "time"}
    assert not imported & forbidden, imported & forbidden
    assert imported <= {"__future__", "warnings", "dataclasses", "numpy", "pandas", "yaml"}, imported

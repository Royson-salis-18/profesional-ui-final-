"""The live path end to end, against a simulated graph service: healthy for 12 minutes, then one container stops."""
import numpy as np

from core import incidents
from core.live import LiveCollector

SERVICES = ["web", "api", "cart", "db", "cache", "queue"]
EDGES = [("web", "api"), ("api", "cart"), ("api", "db"), ("cart", "db"), ("cart", "cache"), ("api", "queue")]
T0 = 1_800_000_000.0


def _iso(ts):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _graph(k, rng, down=(), now=None):
    now = now or T0 + 10 * k
    nodes = []
    for i, s in enumerate(SERVICES):
        if s in down:
            continue                                                  # a stopped container is simply not reported any more
        nodes.append({"id": f"demo:{s}", "name": s, "project": "demo", "type": "service", "status": "healthy", "lastSeen": _iso(now),
                      "metadata": {"state": "running"},
                      "metrics": {"cpu": 5 + i + rng.normal(0, .3), "memory": (200 + 20 * i) * 1e6 + rng.normal(0, 1e6),
                                  "networkRx": 1000.0 * (i + 2) * k + rng.integers(0, 50), "networkTx": 800.0 * (i + 2) * k + rng.integers(0, 50)}})
    edges = [{"source": f"demo:{a}", "target": f"demo:{b}", "declared": True, "observed": True, "evidenceSources": ["compose", "network-tcp"],
              "activity": {"samplesPerMin": 12}} for a, b in EDGES]
    return {"nodes": nodes, "edges": edges, "targets": []}


def _run(crash_at=None, n=110, seed=0):
    rng = np.random.default_rng(seed)
    c = LiveCollector(node_url="unused", step=10, persist=False)
    for k in range(n):
        c.poll(_graph(k, rng, down=("db",) if crash_at is not None and k >= crash_at else ()), now=T0 + 10 * k)
    return c


def test_healthy_system_raises_no_incident():
    c = _run()
    assert incidents.build_incident(c.analyse("demo")) is None


def test_stopped_container_is_blamed_with_the_ui_contract():
    c = _run(crash_at=90)
    inc = incidents.build_incident(c.analyse("demo"))
    assert inc is not None
    assert inc["rootCauseServiceId"] == "demo:db" and inc["severity"] == "CRITICAL" and inc["confidence"] == "HIGH"
    assert inc["candidateCauses"][0]["serviceName"] == "db" and "STOPPED" in inc["candidateCauses"][0]["scoreBreakdown"][0]["reason"]
    assert inc["explanation"]["likelyRootCause"] == "db" and inc["remediationGuide"] == ["docker start db"]
    for key in ("id", "targetId", "startedAt", "status", "symptoms", "affectedServices", "evidence", "propagation", "atRisk", "explanation"):
        assert key in inc, key
    assert inc["source"] == "core"


def test_no_data_is_not_a_crash():
    c = _run()
    stale = _graph(0, np.random.default_rng(1), now=T0 - 3600)          # every node last seen an hour ago: the target is offline
    before = len(c.rows["demo"])
    c.poll(stale, now=T0 + 10 * 111)
    assert len(c.rows["demo"]) == before                                 # skipped, so nothing reads as "everything is down"


def test_edges_come_from_the_graph_service():
    c = _run(n=15)
    assert ("api", "db") in c.edges["demo"] and len(c.edges["demo"]) == len(EDGES)

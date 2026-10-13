#!/usr/bin/env python3
"""End-to-end check of graph service -> core -> UI contract, with no AWS and no Docker.

A simulated target posts telemetry to the graph service's /api/ingest (the same path the remote collector uses): six healthy
services, then one stops reporting. The script waits for GET /api/incidents on the GRAPH SERVICE (what the UI calls) to return an
incident from the core that blames the stopped service.

    CORE_STEP=1 CORE_FRESH_S=3 CORE_PERSIST=0 python -m core          # core on :8000, 1-second ticks for the test
    cd server && npm run start                                         # graph service on :3001
    python scripts/e2e_core_bridge.py
"""
import json
import sys
import time
import urllib.request

NODE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001"
TARGET = sys.argv[2] if len(sys.argv) > 2 else "e2e-demo"
SERVICES = ["web", "api", "cart", "db", "cache", "queue"]
EDGES = [("web", "api"), ("api", "cart"), ("api", "db"), ("cart", "db"), ("cart", "cache"), ("api", "queue")]
HEALTHY_S, CRASH_WAIT_S = 45, 60


def call(path, body=None):
    req = urllib.request.Request(NODE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer mapper-secret-token"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def envelope(k, down=()):
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    up = [s for s in SERVICES if s not in down]
    return {"schemaVersion": "1", "targetId": TARGET, "collectorId": "e2e", "timestamp": now, "source": "e2e", "hostIp": "10.0.0.1", "events": {
        "nodes": [{"id": f"{TARGET}:{s}", "name": s, "type": "service", "project": TARGET, "status": "healthy", "metadata": {"state": "running"}} for s in up],
        "edges": [{"id": f"{TARGET}:{a}->{TARGET}:{b}", "source": f"{TARGET}:{a}", "target": f"{TARGET}:{b}", "type": "dependency", "declared": True,
                   "observed": True, "evidenceSources": ["compose", "network-tcp"], "status": "active", "metrics": None, "protocol": "tcp",
                   "lastSeen": now, "activity": {"samplesPerMin": 12, "windowSec": 60, "lastSeen": now}} for a, b in EDGES],
        "metrics": [{"nodeId": f"{TARGET}:{s}", "snapshot": {"cpu": 5 + i + (k % 3) * .1, "memory": (200 + 20 * i) * 1e6, "memoryPercent": 20 + i,
                                                              "networkRx": 1000.0 * (i + 2) * k, "networkTx": 800.0 * (i + 2) * k}} for i, s in enumerate(up)]}}


def main():
    for k in range(HEALTHY_S):
        call("/api/ingest", envelope(k)); time.sleep(1)
    print(f"{HEALTHY_S}s healthy sent; stopping 'db'")
    t0 = time.time()
    for k in range(HEALTHY_S, HEALTHY_S + CRASH_WAIT_S):
        call("/api/ingest", envelope(k, down=("db",)))
        inc = [i for i in call(f"/api/incidents?targetId={TARGET}") if i.get("source") == "core"]
        if inc:
            i = inc[0]
            print(f"core incident after {time.time() - t0:.0f}s: root={i['rootCauseServiceId']} severity={i['severity']} confidence={i['confidence']} "
                  f"status={i['status']} candidates={[c['serviceName'] for c in i['candidateCauses'][:3]]}")
            assert i["rootCauseServiceId"] == f"{TARGET}:db", i["rootCauseServiceId"]
            print("PASS: the UI's /api/incidents returned the core's incident blaming the stopped container")
            return 0
        time.sleep(1)
    print("FAIL: no incident from the core within", CRASH_WAIT_S, "s")
    return 1


if __name__ == "__main__":
    sys.exit(main())

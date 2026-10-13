from __future__ import annotations

import sys

import numpy as np
import requests


def services(url: str) -> list[str]:
    r = requests.get(f"{url.rstrip('/')}/api/services", timeout=30)
    r.raise_for_status()
    return [s for s in r.json()["data"] if not s.startswith("jaeger")]


def _is_error(span: dict) -> bool:
    for t in span.get("tags", []):
        if t["key"] == "error" and str(t["value"]).lower() == "true":
            return True
        if t["key"] in ("http.status_code", "http.response.status_code"):
            try:
                if int(t["value"]) >= 500:
                    return True
            except (TypeError, ValueError):
                pass
    return False


def _self_time(span: dict, children: list[tuple[int, int]]) -> float:
    """Exclusive time (microseconds): the span's duration minus the time covered by its child spans.
    A slow dependency inflates its callers' duration but not their self time, so self time points at the
    service that is itself slow. Overlapping children are merged so parallel calls are not double counted."""
    s0, s1 = span["startTime"], span["startTime"] + span["duration"]
    covered, last_end = 0, s0
    for a, b in sorted(children):
        a, b = max(a, s0, last_end), min(b, s1)
        if b > a:
            covered += b - a
            last_end = b
    return max(span["duration"] - covered, 0)


def _get_traces(url: str, svc: str, t0: float, t1: float, limit: int, retries: int = 2) -> list[dict]:
    for attempt in range(retries + 1):
        try:
            r = requests.get(f"{url.rstrip('/')}/api/traces", timeout=45,
                             params={"service": svc, "start": int(t0 * 1e6), "end": int(t1 * 1e6), "limit": limit})
            r.raise_for_status()
            return r.json().get("data", []) or []
        except requests.RequestException as e:
            if attempt == retries:
                print(f"[jaeger] {svc} {t0:.0f}-{t1:.0f}: {e}", file=sys.stderr)
    return []


def _pull(url: str, svc: str, t0: float, t1: float, limit: int) -> list[dict]:
    """All traces in [t0, t1). Jaeger returns only the newest `limit`, so a full page means the slice was
    truncated: split it in half and pull each half (down to 2 s) until nothing is cut off."""
    traces = _get_traces(url, svc, t0, t1, limit)
    if len(traces) >= limit and (t1 - t0) > 2:
        mid = (t0 + t1) / 2
        return _pull(url, svc, t0, mid, limit) + _pull(url, svc, mid, t1, limit)
    if len(traces) >= limit:
        print(f"[jaeger] {svc}: >{limit} traces in {t1 - t0:.0f}s, data truncated", file=sys.stderr)
    return traces


def fetch(url: str, service_names: list[str], start: float, end: float, step: int,
          entry_services: list[str] | None = None, slice_s: int = 120, limit: int = 300):
    """Return (latency_p95, error_rate, span_count, self_latency_p95, edges); arrays are (n_windows, n_services).

    Traces are pulled per time slice from `entry_services` (default: all services), de-duplicated by
    trace id, and every span is then attributed to its own service. One request path is therefore not
    counted twice, and a long window is not truncated to the newest `limit` traces.
    """
    n = int((end - start) // step) + 1
    idx = {s: i for i, s in enumerate(service_names)}
    lat = [[[] for _ in service_names] for _ in range(n)]
    slf = [[[] for _ in service_names] for _ in range(n)]
    err = np.zeros((n, len(service_names)))
    tot = np.zeros((n, len(service_names)))
    edges: set[tuple[str, str]] = set()
    seen: set[str] = set()

    t = start
    while t < end:
        for svc in (entry_services or service_names):
            for trace in _pull(url, svc, t, min(t + slice_s, end), limit):
                if trace["traceID"] in seen:
                    continue
                seen.add(trace["traceID"])
                procs = {pid: p["serviceName"] for pid, p in trace["processes"].items()}
                by_id = {s["spanID"]: s for s in trace["spans"]}
                kids: dict[str, list] = {}
                for s in trace["spans"]:
                    for ref in s.get("references", []):
                        kids.setdefault(ref["spanID"], []).append((s["startTime"], s["startTime"] + s["duration"]))
                for s in trace["spans"]:
                    name = procs[s["processID"]]
                    if name not in idx:
                        continue
                    w = int((s["startTime"] / 1e6 - start) // step)
                    if not 0 <= w < n:
                        continue
                    j = idx[name]
                    lat[w][j].append(s["duration"] / 1000.0)  # ms
                    slf[w][j].append(_self_time(s, kids.get(s["spanID"], [])) / 1000.0)
                    tot[w, j] += 1
                    err[w, j] += _is_error(s)
                    for ref in s.get("references", []):
                        parent = by_id.get(ref["spanID"])
                        if parent and procs[parent["processID"]] != name:
                            edges.add((procs[parent["processID"]], name))
        t += slice_s

    p95 = np.full((n, len(service_names)), np.nan)
    sp95 = np.full((n, len(service_names)), np.nan)
    for w in range(n):
        for j in range(len(service_names)):
            if lat[w][j]:
                p95[w, j] = np.percentile(lat[w][j], 95)
                sp95[w, j] = np.percentile(slf[w][j], 95)
    with np.errstate(invalid="ignore", divide="ignore"):
        rate = np.where(tot > 0, err / tot, np.nan)
    return p95, rate, tot, sp95, sorted(edges)

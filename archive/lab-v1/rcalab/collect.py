"""Pull telemetry into one Telemetry object, using whichever method the config selects.

source.mode:
  tools  Jaeger (required: traces give latency, errors, request rate and the call graph) plus optional
         Prometheus / Loki. Works with any architecture that exports OTel/Jaeger traces.
  ssh    Docker-host readings over SSH (cpu, memory, network, error-log counts) from a background sampler;
         the call graph comes from a docker-compose file you provide (or `ssh.extra_edges`).
  both   Traces from the tools, host metrics from SSH, matched to services by container name.

Features a method cannot provide stay NaN, which the detector treats as "no evidence", not "normal".
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from .sources import jaeger, loki, prometheus
from .sources import ssh as sshsrc
from .telemetry import FEATURES, Telemetry

_compose_cache: dict[tuple, list] = {}


def mode(cfg: dict) -> str:
    return (cfg.get("source") or {}).get("mode", "tools")


def sample_path(cfg: dict) -> Path:
    return Path("samples") / f"{cfg['system']['name']}.jsonl"


def ssh_source(cfg: dict) -> sshsrc.SSHSource:
    s = cfg["ssh"]
    return sshsrc.SSHSource(s["host"], s.get("user", "ubuntu"), s["key_path"], int(s.get("port", 22)))


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # tool down / slow / query mismatch: degrade, but say so
        print(f"[collect] {fn.__module__.split('.')[-1]} unavailable: {str(e)[:120]}", file=sys.stderr)
        return None


def _container_names(path: Path) -> list[str]:
    names: set[str] = set()
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines()[-200:]:
            try:
                names |= set(json.loads(line)["svc"])
            except Exception:
                pass
    return sorted(names)


def _ssh_edges(cfg: dict) -> list[tuple[str, str]]:
    s = cfg["ssh"]
    edges = [tuple(e) for e in (s.get("extra_edges") or [])]
    cf = s.get("compose_file")
    if cf:
        key = (s["host"], cf)
        if key not in _compose_cache:
            text = _safe(ssh_source(cfg).read_text_file, cf)
            _compose_cache[key] = sshsrc.compose_edges(text) if text else []
        edges += _compose_cache[key]
    return sorted(set(edges))


def _match(service: str, containers: list[str], name_map: dict) -> str | None:
    if service in name_map:
        return name_map[service]
    hits = [c for c in containers if c == service or service in c]
    return min(hits, key=len) if hits else None


def collect(cfg: dict, start: float, end: float, trim_leading: bool = True,
            services: list[str] | None = None) -> Telemetry:
    step = cfg["collection"]["step_seconds"]
    start = (start // step) * step            # global window grid, so separate pulls line up and can be merged
    n = int((end - start) // step) + 1
    times = start + step * np.arange(n)
    m = mode(cfg)
    src, ssh_cfg = cfg.get("sources", {}), cfg.get("ssh", {})
    sp = sample_path(cfg)

    if m == "ssh":
        names = services or cfg["system"].get("services") or _container_names(sp)
        if not names:
            raise ValueError("No SSH samples yet. The sampler needs a few polls first (check ssh.host / key_path).")
        X = sshsrc.load_windows(sp, start, end, step, names, FEATURES)
        raw = _ssh_edges(cfg)                 # compose service names differ from container names: match by substring
        edges = sorted({(a, b) for ca, cb in raw for a in names for b in names if ca in a and cb in b and a != b})
        signal = [FEATURES.index("cpu"), FEATURES.index("memory"), FEATURES.index("net_rx")]
    else:
        jg = src["jaeger"]
        names = services or cfg["system"].get("services") or sorted(jaeger.services(jg["url"]))
        X = np.full((n, len(names), len(FEATURES)), np.nan)
        prom = src.get("prometheus", {})
        prom_ok = bool(prom.get("url"))
        for j, svc in enumerate(names):
            for key in ("cpu", "memory", "net_rx", "net_tx"):
                if not prom_ok:
                    break
                q = prom["queries"][key].replace("{service}", svc)
                col = _safe(prometheus.query_range, prom["url"], q, start, end, step)
                if col is None:
                    prom_ok = False          # one failure means the tool is down: stop hammering it
                    break
                X[:, j, FEATURES.index(key)] = col
            if src.get("loki", {}).get("url"):
                q = src["loki"]["error_query"].replace("{service}", svc)
                col = _safe(loki.query_range, src["loki"]["url"], q, start, end, step)
                if col is not None:
                    X[:, j, FEATURES.index("log_errors")] = col
        p95, rate, count, selfp95, edges = jaeger.fetch(jg["url"], names, start, end, step, jg.get("entry_services") or None,
                                               jg.get("slice_seconds", 120), jg.get("limit", 300))
        X[:, :, FEATURES.index("latency_p95")] = p95
        X[:, :, FEATURES.index("trace_errors")] = rate
        X[:, :, FEATURES.index("span_rate")] = count
        X[:, :, FEATURES.index("self_latency")] = selfp95
        signal = [FEATURES.index("span_rate")]

        if m == "both":                       # overlay host readings, matched to services by container name
            containers = _container_names(sp)
            hx = sshsrc.load_windows(sp, start, end, step, containers, FEATURES) if containers else None
            for j, svc in enumerate(names):
                c = _match(svc, containers, ssh_cfg.get("name_map") or {})
                if hx is not None and c in containers:
                    ci = containers.index(c)
                    for f in ("cpu", "memory", "net_rx", "net_tx", "log_errors", "container_up"):
                        col = hx[:, ci, FEATURES.index(f)]
                        if not np.isnan(col).all():
                            X[:, j, FEATURES.index(f)] = col

    tel = Telemetry(times, names, X, list(FEATURES), edges)
    tel = tel.slice(0, n - 1)                       # the newest window is still filling: drop it
    active = np.nansum(np.nan_to_num(tel.X[:, :, signal]), axis=(1, 2)) > 0
    first = int(np.argmax(active)) if active.any() and trim_leading else 0
    if first:                                       # nothing existed before this: a baseline of silence is meaningless
        print(f"[collect] no telemetry in the first {first} windows; starting at the first active window", file=sys.stderr)
    return tel.slice(first, len(tel.times))


def merge(old: Telemetry, new: Telemetry, keep: int) -> Telemetry:
    """Append freshly pulled windows to `old` (new wins where they overlap); keep the last `keep` windows."""
    step = old.times[1] - old.times[0]
    if new.services != old.services or new.times[0] > old.times[-1] + step * 1.5:
        return new                                   # service set changed or gap too large: start over
    cut = int(np.searchsorted(old.times, new.times[0]))
    times = np.concatenate([old.times[:cut], new.times])
    X = np.concatenate([old.X[:cut], new.X])
    edges = sorted(set(old.edges) | set(new.edges))
    tel = Telemetry(times, old.services, X, old.features, edges)
    return tel.slice(max(0, len(times) - keep), len(times))

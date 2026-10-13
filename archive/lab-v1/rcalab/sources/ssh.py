"""Optional SSH data source (mode: ssh | both). The ONLY module allowed to open a remote connection.

Safety model: it can run just the fixed, read-only commands in ALLOWED / the two parameterised templates
below. There is no way to pass an arbitrary command. Host keys are pinned on first use in `.known_hosts`
and a changed key is rejected.

SSH only gives *point-in-time* readings, so a Sampler polls every `step` seconds and appends rows to a
JSONL file. `load_windows` turns that file into aligned (windows x services x features) arrays, so history
survives restarts and `record` can cut any labelled window out of it.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

import numpy as np
import yaml

ALLOWED = {
    "stats": "docker stats --no-stream --format '{{json .}}'",
    "containers": "docker ps --format '{{.Names}}'",
}
_LOG_ERRORS = ("docker ps --format '{{.Names}}' | xargs -P 8 -I{} sh -c "
               "'echo \"{} $(docker logs --since %ds {} 2>&1 | grep -ciE \"error|exception|fatal\")\"'")
_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]{1,200}$")
_UNITS = {"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12, "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4}


def _bytes(text: str) -> float:
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", text or "")
    return float(m.group(1)) * _UNITS.get(m.group(2).lower(), 1) if m else float("nan")


class SSHSource:
    def __init__(self, host: str, user: str, key_path: str, port: int = 22, known_hosts: str = ".known_hosts"):
        self.host, self.user, self.port = host, user, port
        self.key_path = str(Path(key_path).expanduser())
        self.known_hosts = known_hosts
        self._client = None

    def _connect(self):
        import paramiko
        if self._client and self._client.get_transport() and self._client.get_transport().is_active():
            return self._client
        c = paramiko.SSHClient()
        if Path(self.known_hosts).exists():
            c.load_host_keys(self.known_hosts)
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())      # trust on first use; a CHANGED key raises
        c.connect(self.host, port=self.port, username=self.user, key_filename=self.key_path,
                  timeout=15, banner_timeout=15, auth_timeout=15, look_for_keys=False, allow_agent=False)
        c.save_host_keys(self.known_hosts)
        self._client = c
        return c

    def _run(self, command: str, timeout: int = 40) -> str:
        """The single place a remote command is executed. Callers pass only allowlisted/validated strings."""
        _, out, _ = self._connect().exec_command(command, timeout=timeout)
        return out.read().decode("utf-8", "replace")

    # ---- allowlisted reads ----
    def containers(self) -> list[str]:
        return [n for n in self._run(ALLOWED["containers"], timeout=30).split() if n]

    def stats(self) -> list[dict]:
        rows = []
        for line in self._run(ALLOWED["stats"], timeout=120).splitlines():
            try:
                d = json.loads(line)
                rx, tx = (_bytes(x) for x in d["NetIO"].split("/"))
                rows.append({"name": d["Name"], "cpu": float(d["CPUPerc"].strip("%")),
                             "mem": _bytes(d["MemUsage"].split("/")[0]), "rx": rx, "tx": tx})
            except (KeyError, ValueError, json.JSONDecodeError):
                continue
        return rows

    def log_errors(self, since_s: int) -> dict[str, int]:
        out = {}
        for line in self._run(_LOG_ERRORS % int(since_s)).splitlines():
            name, _, n = line.rpartition(" ")
            if name and n.isdigit():
                out[name] = int(n)
        return out

    def read_text_file(self, path: str) -> str:
        if not _PATH_RE.match(path) or ".." in path:
            raise ValueError(f"refusing path {path!r}")
        return self._run(f"cat {path}")


def compose_edges(text: str) -> list[tuple[str, str]]:
    """(caller, callee) pairs from `depends_on` / `links` in a docker-compose file."""
    edges = set()
    for svc, spec in ((yaml.safe_load(text) or {}).get("services") or {}).items():
        for key in ("depends_on", "links"):
            deps = (spec or {}).get(key) or []
            for d in (deps if isinstance(deps, (list, dict)) else [deps]):
                edges.add((svc, str(d).split(":")[0]))
    return sorted(edges)


class Sampler(threading.Thread):
    """Polls the host every `step` seconds and appends one JSON row per poll to `path`."""

    def __init__(self, src: SSHSource, path: Path, step: int, log_every_s: int = 60):
        super().__init__(daemon=True)
        self.src, self.path, self.step, self.log_every_s = src, Path(path), step, log_every_s
        self.last_error = None
        self._halt = threading.Event()

    def run(self):
        """One docker-stats reading per cycle; error-log counts every `log_every_s` (they are slower).
        A cycle takes as long as the host needs, so rows are as dense as the host allows."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        last_logs = time.time()
        while not self._halt.is_set():
            t0 = time.time()
            try:
                errs, scanned = {}, t0 - last_logs >= self.log_every_s
                if scanned:
                    errs = self.src.log_errors(int(t0 - last_logs) + 2)
                    last_logs = t0
                row = {"t": t0, "svc": {r["name"]: {"cpu": r["cpu"], "mem": r["mem"], "rx": r["rx"], "tx": r["tx"],
                                                    "err": (errs.get(r["name"], 0) if scanned else None)} for r in self.src.stats()}}
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(row) + "\n")
                self.last_error = None
            except Exception as e:                       # keep sampling through blips
                self.last_error = str(e)[:160]
            self._halt.wait(max(1.0, self.step - (time.time() - t0)))

    def stop(self):
        self._halt.set()


def load_windows(path: Path, start: float, end: float, step: int, names: list[str], features: list[str]) -> np.ndarray:
    """Aligned (windows, services, features) array from a sampler file. Counters become per-second rates.

    container_up: 1 while a container appears in the samples of a window, 0 in a window that WAS sampled but no longer lists a
    container seen earlier (it stopped or crashed: `docker stats` shows only running containers), NaN before it was first seen and
    in windows with no sample at all. Without this feature a crash looks like "no evidence" instead of a failure.
    """
    n = int((end - start) // step) + 1
    X = np.full((n, len(names), len(features)), np.nan)
    covered = np.zeros(n, dtype=bool)
    present = np.zeros((n, len(names)), dtype=bool)
    prev: dict[str, tuple[float, float, float]] = {}
    if not Path(path).exists():
        return X
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = row["t"]
        w = int((t - start) // step)
        if 0 <= w < n:
            covered[w] = True
        for cname, v in row["svc"].items():
            before = prev.get(cname)
            prev[cname] = (t, v["rx"], v["tx"])
            if not 0 <= w < n or cname not in names:
                continue
            j = names.index(cname)
            present[w, j] = True
            X[w, j, features.index("cpu")] = v["cpu"]
            X[w, j, features.index("memory")] = v["mem"]
            if v.get("err") is not None:       # None = no log scan in this cycle (unknown), not zero errors
                k_e = features.index("log_errors")
                X[w, j, k_e] = (0.0 if np.isnan(X[w, j, k_e]) else X[w, j, k_e]) + v["err"]   # scans add up inside a window
            if before and t > before[0]:
                X[w, j, features.index("net_rx")] = max(v["rx"] - before[1], 0) / (t - before[0])
                X[w, j, features.index("net_tx")] = max(v["tx"] - before[2], 0) / (t - before[0])
    if "container_up" in features:
        k = features.index("container_up")
        for j in range(len(names)):
            seen = np.flatnonzero(present[:, j])
            if len(seen) == 0:
                continue
            for w in range(seen[0], n):
                if covered[w]:
                    X[w, j, k] = 1.0 if present[w, j] else 0.0
    return X

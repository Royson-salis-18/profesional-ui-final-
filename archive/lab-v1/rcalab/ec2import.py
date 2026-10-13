"""Link projects to EC2 instances by pasting the AWS console's instance table.

The lab hosts get a new public IP every time they restart, so the IPs saved in
projects go stale. Copying the instance list from the EC2 console and pasting
it here updates every matching project in one step: the SSH host, and the host
part of its Jaeger / Prometheus / Loki URLs. Instances with no matching project
become new SSH projects. Nothing is contacted while importing.
"""
from __future__ import annotations

import re
from pathlib import Path

from . import config, projects

_IID = re.compile(r"^i-[0-9a-f]{8,17}$")
_IPV4 = re.compile(r"^(\d{1,3})(\.\d{1,3}){3}$")
_HOST_IN_URL = re.compile(r"^(\w+://)([^/:]+)(.*)$")
_STATES = {"running", "stopped", "stopping", "pending", "shutting-down", "terminated"}


def parse(text: str) -> list[dict]:
    """Instances from a paste of the EC2 console's instance table (one field per line or tab-separated).

    Each instance is anchored on its instance id; the name is the field just before it. Only fields
    that are recognisable by shape are trusted: the first bare IPv4 is the public address, and the
    key name is the field after the security group (two after the Monitoring value).
    """
    toks = [t.strip() for t in re.split(r"[\t\r\n]+", text or "")]
    toks = [t for t in toks if t]
    anchors = [i for i, t in enumerate(toks) if _IID.match(t)]
    out = []
    for n, i in enumerate(anchors):
        end = anchors[n + 1] - 1 if n + 1 < len(anchors) else len(toks)
        block = toks[i + 1:end]
        name = toks[i - 1] if i > 0 and not _IID.match(toks[i - 1]) else toks[i]
        ip = next((t for t in block if _IPV4.match(t)), None)
        state = next((t.lower() for t in block if t.lower() in _STATES), None)
        mon = next((k for k, t in enumerate(block) if t.lower() in ("disabled", "enabled")), None)
        key = block[mon + 2] if mon is not None and mon + 2 < len(block) else None
        if key and (key in ("–", "-") or re.match(r"^\d{4}/", key)):
            key = None
        out.append({"name": name, "instance_id": toks[i], "ip": ip, "state": state, "key_name": key})
    return out


def _match(name: str, existing: list[str]) -> str | None:
    """Project for an instance name: same slug, or one slug a prefix of the other ('sock-shop' ~ 'sock-shop-major-project')."""
    s = projects.slug(name)
    if s in existing:
        return s
    near = [e for e in existing if s.startswith(e + "-") or e.startswith(s + "-")]
    return near[0] if len(near) == 1 else None


def _swap_host(url: str, ip: str) -> str:
    m = _HOST_IN_URL.match(url or "")
    return f"{m.group(1)}{ip}{m.group(3)}" if m and m.group(2) not in ("localhost", "127.0.0.1") else url


def apply(text: str, key_dir: str = "~/Downloads", key_path: str = "") -> dict:
    """Upsert one project per parsed instance. Returns what changed, per instance."""
    found = parse(text)
    if not found:
        return {"error": "No instances found. Copy the rows from the EC2 console's Instances table (including the instance ids)."}
    existing, rows = projects.names(), []
    for inst in found:
        row = {"instance": inst["name"], "ip": inst["ip"], "state": inst["state"], "changes": []}
        rows.append(row)
        if not inst["ip"]:
            row.update(project=None, action="skipped", note="no public IPv4 (stopped?)")
            continue
        key = key_path.strip() or (str(Path(key_dir or "~").expanduser() / f"{inst['key_name']}.pem") if inst["key_name"] else "")
        name = _match(inst["name"], existing)
        if name:
            c = projects.load(name)
            row.update(project=name, action="updated")
        else:
            c = config.load(projects.TEMPLATE)
            c["system"]["name"] = projects.slug(inst["name"])
            c.setdefault("source", {})["mode"] = "ssh"
            row.update(project=c["system"]["name"], action="created")
        ss = c.setdefault("ssh", {})
        if ss.get("host") != inst["ip"]:
            old = ss.get("host")
            row["changes"].append(f"ssh host {old if old not in (None, '', config.REQUIRED) else '—'} → {inst['ip']}")
            ss["host"] = inst["ip"]
        if key and ss.get("key_path") in (None, "", config.REQUIRED):
            ss["key_path"] = key
            row["changes"].append(f"key {key}")
        for src in ("jaeger", "prometheus", "loki"):
            s = c["sources"].get(src) or {}
            u = s.get("url") or ""
            if u and u != config.REQUIRED:
                nu = _swap_host(u, inst["ip"])
                if nu != u:
                    row["changes"].append(f"{src} {u} → {nu}")
                    s["url"] = nu
        kp = ss.get("key_path")
        if kp and kp != config.REQUIRED and not Path(kp).expanduser().exists():
            row["note"] = f"key file not found: {kp}"
        projects.save(c)
        if row["action"] == "created":
            existing.append(row["project"])
    return {"ok": True, "instances": rows}

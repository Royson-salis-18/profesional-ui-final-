"""Project registry: one saved config per target system, plus which one is active.

projects/<slug>.yaml   a full config (same schema as config.example.yaml) for one system
projects/_active.txt   slug of the project the dashboard / CLI use by default
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from . import config

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "projects"
TEMPLATE = ROOT / "config.example.yaml"
MODES = ("tools", "ssh", "both")


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower()).strip("-.")


def path(name: str) -> Path:
    s = slug(name)
    if not s or s.startswith("_"):
        raise ValueError(f"invalid project name {name!r}")
    return DIR / f"{s}.yaml"


def load(name: str) -> dict:
    return config.load(path(name))


def names() -> list[str]:
    return sorted(p.stem for p in DIR.glob("*.yaml")) if DIR.exists() else []


def active() -> str | None:
    f = DIR / "_active.txt"
    cur = f.read_text(encoding="utf-8").strip() if f.exists() else ""
    return cur if cur in names() else (names()[0] if names() else None)


def set_active(name: str):
    if slug(name) not in names():
        raise KeyError(name)
    DIR.mkdir(exist_ok=True)
    (DIR / "_active.txt").write_text(slug(name), encoding="utf-8")


def save(cfg: dict) -> str:
    """Write a project; its file name comes from system.name. Returns the slug."""
    DIR.mkdir(exist_ok=True)
    p = path(cfg["system"]["name"])
    p.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
    return p.stem


def delete(name: str):
    path(name).unlink(missing_ok=True)
    if active() is None:
        (DIR / "_active.txt").unlink(missing_ok=True)


def summary(cfg: dict) -> str:
    m = (cfg.get("source") or {}).get("mode", "tools")
    bits = []
    if m in ("tools", "both"):
        u = cfg["sources"]["jaeger"]["url"]
        bits.append("jaeger " + (u.split("//")[-1].split("/")[0] if u != "REQUIRED" else "not set"))
    if m in ("ssh", "both"):
        h = cfg.get("ssh", {}).get("host", "REQUIRED")
        bits.append("ssh " + ("not set" if h == "REQUIRED" else h))
    return " · ".join(bits)


def listing() -> list[dict]:
    out = []
    for n in names():
        try:
            c = load(n)
            out.append({"name": n, "mode": (c.get("source") or {}).get("mode", "tools"), "summary": summary(c),
                        "missing": config.missing(c)})
        except Exception as e:                      # a hand-edited file should not break the list
            out.append({"name": n, "mode": "?", "summary": f"unreadable: {e}"[:80], "missing": ["file"]})
    return out


def to_form(cfg: dict) -> dict:
    """Flat dict the UI edits."""
    j, ss, col = cfg["sources"]["jaeger"], cfg.get("ssh", {}), cfg["collection"]
    blank = lambda v: "" if v in (None, "REQUIRED") else v
    return {"mode": (cfg.get("source") or {}).get("mode", "tools"), "system_name": blank(cfg["system"]["name"]),
            "services": ",".join(cfg["system"].get("services") or []),
            "jaeger_url": blank(j["url"]), "jaeger_entry": ",".join(j.get("entry_services") or []),
            "prometheus_url": cfg["sources"]["prometheus"].get("url", ""), "loki_url": cfg["sources"].get("loki", {}).get("url", ""),
            "ssh_host": blank(ss.get("host")), "ssh_user": ss.get("user", "ubuntu"), "ssh_port": ss.get("port", 22),
            "ssh_key_path": blank(ss.get("key_path")), "ssh_compose_file": ss.get("compose_file", ""),
            "step_seconds": col["step_seconds"], "baseline_minutes": col["baseline_minutes"]}


def from_form(form: dict, base: dict | None = None) -> dict:
    """Apply the UI's flat form onto a config (a copy of `base`, or the template)."""
    if form["mode"] not in MODES:
        raise ValueError("mode must be tools, ssh or both")
    c = base or config.load(TEMPLATE)
    csv = lambda s: [x.strip() for x in str(s).split(",") if x.strip()]
    c.setdefault("source", {})["mode"] = form["mode"]
    c["system"]["name"] = form["system_name"].strip() or config.REQUIRED
    c["system"]["services"] = csv(form.get("services", ""))
    c["sources"]["jaeger"]["url"] = form["jaeger_url"].strip() or config.REQUIRED
    c["sources"]["jaeger"]["entry_services"] = csv(form.get("jaeger_entry", ""))
    c["sources"]["prometheus"]["url"] = form["prometheus_url"].strip()
    c["sources"].setdefault("loki", {})["url"] = form["loki_url"].strip()
    ss = c.setdefault("ssh", {})
    ss.update(host=form["ssh_host"].strip() or config.REQUIRED, user=form["ssh_user"].strip() or "ubuntu",
              port=int(form["ssh_port"]), key_path=form["ssh_key_path"].strip() or config.REQUIRED,
              compose_file=form["ssh_compose_file"].strip())
    c["collection"]["step_seconds"] = max(5, int(form.get("step_seconds") or 15))
    c["collection"]["baseline_minutes"] = max(1, int(form.get("baseline_minutes") or 10))
    return c


def migrate_legacy():
    """If a single config.yaml exists and there are no projects yet, import it as the first project."""
    legacy = ROOT / "config.yaml"
    if legacy.exists() and not names():
        c = config.load(legacy)
        if c["system"]["name"] != config.REQUIRED:
            set_active(save(c))

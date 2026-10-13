"""Config loading. Anything marked REQUIRED must be supplied by the user."""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

REQUIRED = "REQUIRED"


def load(path: str | Path = "config.yaml") -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def missing(cfg: dict) -> list[str]:
    """Dotted paths of every REQUIRED value that the chosen source.mode actually needs."""
    mode = (cfg.get("source") or {}).get("mode", "tools")
    keys = _missing(cfg)
    if mode == "tools":
        keys = [k for k in keys if not k.startswith("ssh.")]
    elif mode == "ssh":
        keys = [k for k in keys if not k.startswith("sources.")]
    return keys


def _missing(cfg: dict, prefix: str = "") -> list[str]:
    out = []
    for k, v in cfg.items():
        p = f"{prefix}{k}"
        if isinstance(v, dict):
            out += _missing(v, p + ".")
        elif v == REQUIRED:
            out.append(p)
    return out


def _set(cfg: dict, dotted: str, value):
    node = cfg
    *parents, leaf = dotted.split(".")
    for p in parents:
        node = node[p]
    node[leaf] = value


def init(template: str | Path = "config.example.yaml", out: str | Path = "config.yaml") -> dict:
    """Copy the template and interactively request every REQUIRED value."""
    cfg = load(template)
    for key in missing(cfg):
        if not sys.stdin.isatty():
            break
        _set(cfg, key, input(f"{key}: ").strip() or REQUIRED)
    Path(out).write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
    return cfg


def require_complete(cfg: dict):
    gaps = missing(cfg)
    if gaps:
        raise SystemExit("config.yaml is missing required values:\n  " + "\n  ".join(gaps)
                         + "\nRun `python -m rcalab init` or edit the file.")

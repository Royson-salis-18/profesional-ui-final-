from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .telemetry import Telemetry


def save(path: Path, tel: Telemetry):
    np.savez_compressed(path, times=tel.times, X=tel.X,
                        meta=json.dumps({"services": tel.services, "features": tel.features,
                                         "edges": tel.edges}))


def load(path: Path) -> Telemetry:
    d = np.load(path, allow_pickle=False)
    meta = json.loads(str(d["meta"]))
    return Telemetry(d["times"], meta["services"], d["X"], meta["features"],
                     [tuple(e) for e in meta["edges"]])

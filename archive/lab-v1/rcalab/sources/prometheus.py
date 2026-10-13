from __future__ import annotations

import numpy as np
import requests


def query_range(url: str, promql: str, start: float, end: float, step: int) -> np.ndarray:
    """Aligned series of length n_windows (NaN where Prometheus has no sample)."""
    r = requests.get(f"{url.rstrip('/')}/api/v1/query_range", timeout=30,
                     params={"query": promql, "start": start, "end": end, "step": step})
    r.raise_for_status()
    n = int((end - start) // step) + 1
    out = np.full(n, np.nan)
    result = r.json()["data"]["result"]
    if result:
        for ts, val in result[0]["values"]:
            i = int(round((float(ts) - start) / step))
            if 0 <= i < n:
                out[i] = float(val)
    return out

from __future__ import annotations

import numpy as np
import requests


def query_range(url: str, logql: str, start: float, end: float, step: int) -> np.ndarray:
    r = requests.get(f"{url.rstrip('/')}/loki/api/v1/query_range", timeout=30,
                     params={"query": logql, "start": int(start * 1e9), "end": int(end * 1e9),
                             "step": step})
    r.raise_for_status()
    n = int((end - start) // step) + 1
    out = np.zeros(n)
    for series in r.json()["data"]["result"]:
        for ts, val in series["values"]:
            i = int(round((float(ts) - start) / step))
            if 0 <= i < n:
                out[i] += float(val)
    return out

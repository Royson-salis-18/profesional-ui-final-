"""Plain-language explanation of an RCA result. Explains only; it never changes the ranking."""
from __future__ import annotations

import numpy as np

from .detector import Detection
from .rca import RCAResult
from .telemetry import Telemetry


def explain(tel: Telemetry, det: Detection, res: RCAResult, window: tuple[int, int],
            top_n: int = 3, risk_floor: float = 0.3) -> str:
    if not res.ranking:
        return "No service deviated from its baseline in this window."
    s0, s1 = window
    lines = []
    for rank_i, (svc, score) in enumerate(res.ranking[:top_n], 1):
        i = tel.index(svc)
        fz = det.feature_z[s0:s1, i].max(axis=0)
        worst = np.argsort(-fz)[:2]
        feats = ", ".join(f"{tel.features[f]} ({fz[f]:.1f}x normal spread)" for f in worst if fz[f] > 0)
        onset_t = tel.times[res.onset[svc]]
        impacted = [(v, res.P[i, tel.index(v)]) for v in res.strength
                    if v != svc and res.P[i, tel.index(v)] > 0.2]
        impacted.sort(key=lambda x: -x[1])
        line = f"#{rank_i} {svc} (score {score:.2f}): first deviated at t={onset_t:.0f}; unusual {feats}."
        if impacted:
            line += " Likely knock-on effects: " + ", ".join(f"{v} ({p:.0%})" for v, p in impacted) + "."
        lines.append(line)
    at_risk = sorted(((s, r) for s, r in res.risk.items() if r >= risk_floor and s not in res.strength),
                     key=lambda x: -x[1])
    if at_risk:
        lines.append("Not yet failing but at cascade risk: "
                     + ", ".join(f"{s} ({r:.0%})" for s, r in at_risk[:5]) + ".")
    return "\n".join(lines)


def suspects(tel: Telemetry, det: Detection, res: RCAResult, window: tuple[int, int],
             top_n: int = 4) -> list[dict]:
    """Structured version of `explain` for UIs: the same facts, as data."""
    s0, s1 = window
    out = []
    top_score = res.ranking[0][1] if res.ranking else 1.0
    for svc, score in res.ranking[:top_n]:
        i = tel.index(svc)
        fz = det.feature_z[s0:s1, i].max(axis=0)
        feats = [{"name": tel.features[f], "z": float(fz[f])} for f in np.argsort(-fz)[:3] if fz[f] > 0]
        impacted = sorted(({"service": v, "p": float(res.P[i, tel.index(v)])} for v in res.strength
                           if v != svc and res.P[i, tel.index(v)] > 0.2), key=lambda x: -x["p"])
        out.append({"service": svc, "score": float(score), "rel": float(score / top_score) if top_score > 0 else 0.0,
                    "onset_window": int(res.onset[svc]), "features": feats, "impacted": impacted})
    return out

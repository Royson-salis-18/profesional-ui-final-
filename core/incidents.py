"""Shape an Analysis (core.live) into the incident object the UI reads (client/src/types: Incident).

This is presentation only: every number comes from core.algo. The wording explains the evidence; it never changes the ranking.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from .algo import callers_of


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ts * 1000) % 1000:03d}Z"


def _short(name: str, target: str) -> str:
    return name.replace(f"{target}-", "", 1) if name.startswith(f"{target}-") else name


def _confidence(top: float, second: float, stopped: bool, tau: float) -> str:
    """HIGH = a stopped container (a fact) or a clear lead well above the threshold; MEDIUM = a moderate lead; LOW = a close call."""
    if stopped or (top >= 2 * tau and second <= 0.5 * top):
        return "HIGH"
    return "MEDIUM" if top > 0 and second <= 0.8 * top else "LOW"


def build_incident(a) -> dict | None:
    """The incident for the alarm active now (or just cleared), or None when nothing is wrong."""
    if a is None or a.window is None or a.attribution is None or a.attribution.empty:
        return None
    p, sc, att, tau, t = a.panel, a.scores, a.attribution, a.tau, a.t
    t0, t1 = a.window
    flagged_now = [p.services[i] for i in np.flatnonzero(a.flags[t])]
    top = att.iloc[0]
    stopped = "STOPPED" in str(top.note)
    second = float(att.iloc[1].score) if len(att) > 1 else 0.0
    conf = _confidence(float(top.score), second, stopped, tau)
    short = lambda s: _short(s, a.target)
    node = lambda s: a.ids.get(s, f"{a.target}:{s}")
    status = ("INCIDENT" if (stopped or float(top.score) >= 2 * tau) else "DEGRADED") if flagged_now else "RECOVERING"
    severity = "CRITICAL" if stopped else "HIGH" if float(top.score) >= 3 * tau else "MEDIUM" if float(top.score) >= tau else "LOW"
    started = float(p.times[t0])

    cands = []
    for _, r in att.head(5).iterrows():
        fz = sc.z[t0:t1, p.services.index(r.service)].max(axis=0)
        k = int(np.argmax(fz)) if fz.size and fz.max() > 0 else None
        # The score is max(own evidence, unexplained symptoms) + 100 if the container stopped: list exactly those terms, so they add up.
        own_wins = float(r.own) >= float(r.unexplained)
        breakdown = [{"factor": "own_evidence" if own_wins else "unexplained_symptoms", "score": float(max(r.own, r.unexplained)),
                      "reason": (f"own evidence {r.own:.1f} (CPU, memory, own time, container up, silence)" if own_wins else
                                 f"symptoms {r.symptoms:.1f} minus {r.explained:.1f} explained by a broken callee = {r.unexplained:.1f}")}]
        if r.note and "STOPPED" in str(r.note):
            breakdown.insert(0, {"factor": "hard_evidence", "score": 100.0, "reason": str(r.note)})
        cands.append({"serviceId": node(r.service), "serviceName": r.service, "score": float(r.score),
                      "confidence": conf if r.name == 0 else "LOW", "scoreBreakdown": breakdown,
                      "earliestAnomalyTimestamp": _iso(started), "primaryAnomalyMetric": sc.features[k] if k is not None else r.top_feature or None})

    up = callers_of(p.edges)
    victims = [s for s in flagged_now if s != top.service]
    path = [short(top.service)] + [short(c) for c in up.get(top.service, []) if c in flagged_now]
    evidence = []
    for s in [top.service] + victims[:5]:
        i = p.services.index(s)
        fz = sc.z[t0:t1, i].max(axis=0); k = int(np.argmax(fz))
        if fz[k] <= 0:
            continue
        evidence.append({"id": f"ev-{a.target}-{s}-{int(started)}", "metric": sc.features[k], "timestamp": _iso(float(p.times[t])),
                         "beforeValue": "its own normal range", "afterValue": f"{fz[k]:.1f}x its normal spread", "source": "core-detector",
                         "description": f"'{short(s)}' is {fz[k]:.1f}x outside its own normal range on {sc.features[k].replace('_', ' ')}"})
    if stopped:
        evidence.insert(0, {"id": f"ev-{a.target}-stopped-{int(started)}", "metric": "container_up", "timestamp": _iso(float(p.times[t])),
                            "beforeValue": "running", "afterValue": "not reported", "source": "docker-stats",
                            "description": f"'{short(top.service)}' disappeared from the container list while its neighbours still report"})

    why = ("Hard evidence: the container stopped. Its callers' errors are symptoms inherited from it." if stopped else
           f"Highest unexplained evidence: {float(top.score):.1f} (own {float(top.own):.1f}, symptoms {float(top.symptoms):.1f}, "
           f"{float(top.explained):.1f} explained by a failing callee).")
    at_risk = [{"serviceId": node(s), "serviceName": s, "risk": float(v), "via": [short(c) for c in flagged_now if (s, c) in set(p.edges)]}
               for s, v in a.at_risk.sort_values(ascending=False).items() if v >= 0.15][:5]
    return {
        "id": f"core-{a.target}-{int(started * 1000)}", "targetId": a.target, "startedAt": _iso(started), "detectedAt": _iso(started),
        "endedAt": None if flagged_now else _iso(float(p.times[t])), "status": status, "severity": severity,
        "rootCauseServiceId": node(top.service), "rootCauseEdgeId": None, "rootCauseScore": float(top.score), "confidence": conf,
        "symptoms": [f"Service '{short(s)}' is outside its own normal range" for s in flagged_now],
        "anomalies": [], "propagation": [{"sourceId": node(top.service), "targetId": node(c), "edgeId": f"{node(c)}->{node(top.service)}",
                                          "evidenceSource": "core-attribution", "metricChange": "inherits the failure", "confidence": conf}
                     for c in up.get(top.service, []) if c in flagged_now],
        "affectedServices": [short(s) for s in flagged_now], "candidateCauses": cands, "evidence": evidence,
        "explanation": {"whatHappened": f"{len(flagged_now) or 'Some'} service(s) of '{a.target}' left their own normal range.",
                        "whenStarted": _iso(started), "likelyRootCause": short(top.service), "why": why, "propagationPath": path,
                        "affectedServices": [short(s) for s in flagged_now], "confidence": conf,
                        "alternativeCandidates": [{"name": short(r.service), "score": float(r.score), "confidence": "LOW"} for _, r in att.iloc[1:4].iterrows()],
                        "evidenceSummary": [e["description"] for e in evidence],
                        "recommendedInvestigation": ([f"docker start {top.service}  (it stopped)", f"docker logs --tail 100 {top.service}"] if stopped else
                                                     [f"docker logs --tail 100 {top.service}", f"docker stats --no-stream {top.service}",
                                                      "Check whether its callers' errors started after it did"])},
        "remediationGuide": [f"docker start {top.service}"] if stopped else [],
        "atRisk": at_risk, "monitoringGap": False, "source": "core",
    }

# 17 — Findings vs Incidents: two detectors, deliberately separate

This page explains why the app has two places that both say "something is
wrong", what each one is allowed to use, and where every piece of the ML
output moved to.

---

## 1. The split

| | **Findings** | **Incidents** |
|---|---|---|
| Nav | Findings (microscope) | Incidents (warning triangle) |
| Source | Trained detectors — Isolation Forest, LOF, One-Class SVM, z-score | Fixed rules on live metrics |
| Needs | features.csv, a fitted artefact per service, `score.py` running | Nothing but a metric history |
| Claim | "this service is behaving unlike its own learned history" | "this metric broke a stated rule" |
| Works on a target trained 0 times? | No | Yes |
| Works while the scorer is stopped? | No | Yes |
| Code | `ml/` + `FindingsView.tsx` | `server/rca/` + `RCAView.tsx` |

They share no code. `server/rca/` does not import anything from `ml/`, and a
grep for `latest_scores`, `isolation` or `anomaly_score` under `server/rca/`
returns nothing. That is the design, not an accident of history.

### Why they must stay separate

**Incidents have to work when the models cannot.** An incident must fire on a
service discovered a minute ago, on a target whose models were never trained,
while `score.py` is stopped — which, in practice, is most of the time. A model
cannot do that: it needs enough training rows, a fitted artefact and a running
scorer. A fixed rule on a live metric needs none of those.

**The research needs it.** The models are the object of study. If incidents
were raised by the models, every evaluation of those models would be scored
against alerts the models themselves produced — the detector grading its own
homework. Keeping the rule-based path independent means it can act as a
reference the model output is compared *against*.

**They fail differently, and that is useful.** A rule misses a slow drift that
never crosses 70%. A model misses a failure mode that was present throughout
training and so looks normal to it. Two independent signals disagreeing is
information; one signal wearing two hats is not.

---

## 2. Incidents: the rules

Defined in `server/rca/thresholds.ts`, overridable via
`server/data/incident_thresholds.json`, and editable in the UI under
**Incidents → Detection rules**.

Every value below was previously a literal inside `AnomalyDetector.ts`, where
the only way to answer "why did this fire?" was to read the source.

| Rule | Default | Meaning |
|---|---|---|
| `minHistorySamples` | 3 | Samples needed before a service is judged at all |
| `zScoreAnomaly` | 2.5 | \|z\| at or above this is anomalous |
| `zScoreHigh` | 3.0 | …and HIGH |
| `zScoreCritical` | 4.0 | …and CRITICAL |
| `absoluteHighPercent` | 70 | Reading above this is HIGH regardless of z |
| `absoluteCriticalPercent` | 85 | …and CRITICAL regardless of z |
| `flatlineStdDev` | 0.001 | Below this std dev the baseline counts as flat |
| `flatlineDeltaPercent` | 30 | On a flat baseline, a jump this big is the anomaly |
| `flatlineCriticalPercent` | 80 | On a flat baseline, a value above this is CRITICAL |
| `criticalServicesForCritical` | 2 | Critical services needed before the incident is CRITICAL |

### The flat-baseline rule exists for a real reason

A z-score divides by the standard deviation. Most services here sit perfectly
still — `sock-shop:front-end` records 6 distinct values across 1568 samples —
so the deviation approaches zero and the z-score explodes, making every tiny
movement look infinitely anomalous. Below `flatlineStdDev` the baseline is
treated as flat and judged on absolute movement instead. This is the rule that
catches an idle service suddenly doing work.

### Editing

`POST /api/incidents/thresholds` with any subset of the keys, or
`{"reset": true}`. Every value is clamped to a stated range — posting
`absoluteCriticalPercent: 999` stores `100` — so a bad edit cannot silently
disable detection. Thresholds are re-read on each detection pass, so a change
takes effect on the next cycle with no restart.

The right values are target-dependent. A 909 MB box pinned at 90% CPU needs
different bounds from one that idles at 2%; that is why they are editable
rather than tuned once and hardcoded.

---

## 3. Findings: what the models say

**Current findings** — services above their model's own p99 training
threshold, split by whether the breach is *persistent* (has held for the
configured number of consecutive scoring cycles) or a single cycle. Persistent
ones sort first; a single cycle above threshold is very often one noisy sample.

**Live anomaly scores / Anomaly score trend** — current score per service, and
its history once a service is selected.

**Anomaly score distribution** — where scored services sit, bucketed.

**Model check — holdout firing rate** — how often each model fires on the
chronological tail it never saw. The tail is unlabelled, so this is a *firing
rate*, not accuracy, and the honest comparison is against contamination.

**Detectors by project** — per detector: fitted, refused, mean firing rate.
Four detectors only earn their cost if they can disagree; if agreement is 1.0
everywhere they are adding cost and no information.

**Distinct signal per service** — distinct vs total training rows. The first
number to check when every detector fires on 0%.

**Feature explorer** — the actual rows the models were fitted on.

### Findings can be empty and that is not a bug

If the scorer is stopped or the target unreachable, nothing is scored, and the
page says so rather than showing stale numbers as if they were live. What was
learned at training time is still shown; what is happening *now* is not,
because nothing measured it.

---

## 4. What moved, and what ML Pipeline is now

**ML Pipeline** is the machine — how the pipeline is configured and how far
each service has got through it:

- Pipeline processes (collector, scorer) with start/stop
- Execution panel (scope, preprocess, train; hyperparameters and suggestions)
- Configuration
- Stage cards: collection → preprocessing → training → scoring
- Per-service pipeline progress
- Cross-project funnel (only when not scoped to one project)

**Findings** is the output. Everything listed in §3 moved there from ML
Pipeline, which had grown into one page carrying both the controls and the
results.

The components were exported from `MLPipelineView.tsx` and composed in
`FindingsView.tsx` rather than cut and pasted, so there is exactly one
implementation of each chart. A banner on ML Pipeline points to Findings so
the move is discoverable rather than something to hunt for.

---

## 5. Naming

"Results" was the request; **Findings** is what it is called, for three
reasons:

1. *Results* is ambiguous in a repo that also has experiment results, traffic
   results and RCA results. Findings is unclaimed.
2. It is the right strength of claim. These are things the models *found*,
   which may be artefacts of thin training data — not conclusions.
3. It sits naturally beside Incidents: findings are observations, incidents
   are events with a severity that demand a response.

---

## 6. Where things live

| What | Where |
|---|---|
| Threshold definitions, defaults, limits, docs | `server/rca/thresholds.ts` |
| Threshold overrides (gitignored) | `server/data/incident_thresholds.json` |
| Rule evaluation | `server/rca/AnomalyDetector.ts` |
| Incident severity from rule output | `server/rca/IncidentManager.ts` |
| Threshold API | `GET`/`POST /api/incidents/thresholds` |
| Rules UI | `client/src/components/IncidentRulesPanel.tsx` |
| Findings page | `client/src/components/FindingsView.tsx` |
| Shared output charts | exported from `client/src/components/MLPipelineView.tsx` |

### One trap worth remembering

`/api/incidents/thresholds` must be registered **before** `/api/incidents/:id`.
Express matches in order, so with the wrong order `thresholds` is read as an
incident id and the endpoint returns `{"error":"Incident not found"}`. This
happened during implementation and is now guarded by a comment at the call
site.

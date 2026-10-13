# RCA Engine — Root Cause Analysis

> **Rewritten 2026-10-12: the research method (rca-lab `core/`) is now the mapper's RCA. This box replaces the scoring
> described further down, which is kept only as history.**
>
> **Detector** (`AnomalyDetector.ts`), every metric judged against the service's own last 15 minutes:
>
> | Piece | What it does | Why (measured in rca-lab on 751 labelled faults) |
> |---|---|---|
> | robust baseline | median + MAD of past samples only | one spike cannot move it |
> | self-healing | samples that were part of a **sustained** anomaly are left out of the baseline | a long fault never becomes "normal" |
> | one-sided, log scale | latency/errors only count going up, traffic only going down; ratios not differences | a speed-up is not a fault; big services do not dominate |
> | noise normalisation | a series that is jumpy when healthy is shrunk so its healthy extreme sits at z = 3 | without it: −9 points of accuracy, 8× the false alarms |
> | **silence** | a usually-busy service with no CPU and no network for 3 samples | frozen services found 100% instead of 1% |
> | hard evidence | container paused / exited / restarting / restarted / **vanished** | a fact, not a degree |
> | persistence | two consecutive samples must agree; missing = unknown | single noisy samples do not alarm |
>
> Signals: CPU, memory, network rx/tx **rates**, and when a request-level source exists, p95 latency, error rate and
> request rate. Each anomaly is tagged **own** (about the service itself), **symptom** (can be inherited from a broken
> dependency) or **hard**.
>
> **Ranking** (`RCAEngine.ts`): `score = max(own, symptoms − γ·evidence of the services it calls) + 100 if hard`.
> A broken dependency explains its callers; a silent service is not blamed when something it calls broke loudly; a
> service with no telemetry whose callers fail unexplained is inferred (blind spot); if most services go silent at
> once, it is reported as a **monitoring outage** and nobody is blamed. Incidents now carry **`atRisk`**: healthy
> callers of a broken service, ranked by noisy-OR risk (a watch list, not a calibrated probability).
> Honest note from the research: explain-away was not better than "most abnormal" on the bench; the scoring is what
> matters. `explainAwayGamma = 0` gives plain "most abnormal".
>
> **Remote targets, fixed:** container state from `docker inspect` now reaches the graph (it was hard-coded to
> `running`, so stopped and paused containers on EC2 were invisible); a discovered container missing from `docker stats`
> while the others still report is marked **exited (vanished)**. **`MAPPER_AUTO_RESTART` is now opt-in** (`=on`):
> on by default it silently undid injected faults on reconnect. Remediation hints name the real container and the
> right command (`docker unpause` for a paused one).
>
> **Measured on the mapper's own stored history** (50 real series, 323 series-hours from train-ticket, vertikal and
> bench1, no labels): alarm episodes fell from **0.30 to 0.034 per series-hour** (about 9× fewer; the threshold change
> alone accounts for ~13%). Faults injected into the same real series: memory leak caught 14/14 (old 7/14), CPU busy
> loop 5/14 (old 4/14), frozen service 2/2 (old 0/2). Small samples; the stored series are unlabelled, so some of the
> removed alarms may have been real.
>
> Tests: `tests/rca.test.ts` + `tests/rca-research.test.ts` (16 new tests).

> **Earlier correction (2026-10-08, commit e66d261), superseded by the box above.**

>
> | Old rule | Problem (found by tests / live faults) | Now |
> |---|---|---|
> | +0.15 "downstream blast radius" when a service's **callee** is failing | edges are caller -> callee and failures travel callee -> caller, so this **rewarded victims**: the caller of a broken service outranked the broken service | **-0.25 "likely victim"** if a callee is also failing/anomalous; **+0.15 "explains callers"** if its callers fail while its own callees are fine |
> | candidates = services with Docker status critical/degraded only | an incident raised by metric anomalies on running services had **no root cause** | candidates = failing **or** anomalous services |
> | propagation path walks root -> its callees | drawn **backwards** | walks root -> its callers (where the failure goes) |
> | +0.30 temporal precedence ("strongest signal") | samples are seconds apart, calls take milliseconds: order is mostly sampling noise (rca-lab measured it making rankings worse) | +0.10 |
> | +0.20 for having observed edges | almost every service has traffic; not evidence of being the cause | no score; still raises confidence |
> | detector: mean/std over a 15 min window that includes the anomaly, one sample fires, missing reading = 0 | the fault inflated its own baseline; a single noisy sample raised an incident; gaps looked like drops | median/MAD baseline of history **before** the judged samples, **two** consecutive samples must agree, missing = unknown |
> | `docker pause` -> status `unknown` | frozen containers were invisible | `paused` = critical, `container-paused` anomaly |
>
> Tests: `tests/rca.test.ts` (9 tests; 7 fail on the old code).


**Files:** `server/rca/RCAEngine.ts`, `IncidentManager.ts`, `TemporalAnalyzer.ts`, `ExplanationEngine.ts`, `AnomalyDetector.ts`

---

## What It Does

When services degrade or fail, the RCA engine tries to identify the root cause — the original node that triggered a cascade — by scoring each failing node on multiple evidence factors.

This is **evidence-based scoring**, not ML inference. It's deterministic and explainable. The score tells you "this node is most likely the root cause because it had the earliest anomaly AND it's connected to all the failing downstream services."

---

## Trigger Conditions

`IncidentManager.evaluateTarget(targetId)` is called every 5 seconds (server polling interval). It triggers `RCAEngine.analyzeIncident()` if:
- Any node has `status === 'critical'` or `status === 'degraded'`
- OR the ML pipeline has recorded any anomaly for nodes in this target

If neither condition is met, the result is `{ incidentDetected: false }`.

---

## Scoring Algorithm

For each failing node, a score from 0.0 to ~1.1 is built additively:

### Factor 1: Temporal Precedence (+0.30)

The node whose anomaly was detected earliest gets +0.30. All others get +0.10 if they have an anomaly at all.

```typescript
const earliestNodeId = this.temporalAnalyzer.findEarliestAnomalousNode(targetAnomalies);

if (node.id === earliestNodeId) {
  score += 0.30;  // Most likely root cause
} else if (targetAnomalies.some(a => a.nodeId === node.id)) {
  score += 0.10;  // Anomalous but not first
}
```

**Rationale:** Failure propagates downstream. The node that went anomalous first most likely caused the others. This is the strongest single signal for root cause identification.

### Factor 2: Health Status (+0.35 or +0.15)

```typescript
if (node.status === 'critical' || node.metadata?.state === 'exited') {
  score += 0.35;  // Container process exited — strong signal
} else if (node.status === 'degraded') {
  score += 0.15;  // Resource pressure — weaker signal
}
```

**Rationale:** A container that has actually exited is much more likely to be a root cause than one that's merely running slowly. `state === 'exited'` (from Docker container state) is a definitive indicator of failure.

### Factor 3: Dependency Evidence (+0.20 or +0.05)

```typescript
const connectedEdges = edges.filter(e => e.source === node.id || e.target === node.id);
const hasObservedEdge = connectedEdges.some(e => e.observed);

if (hasObservedEdge) {
  score += 0.20;  // Runtime TCP/HTTP traffic confirms the dependency path
} else if (connectedEdges.some(e => e.declared)) {
  score += 0.05;  // Only Compose-declared — weak circumstantial evidence
}
```

**Rationale:** If we can see actual traffic (observed edge), the causal path is confirmed. A declared-only edge just means "they were supposed to talk" — not that they actually did.

### Factor 4: Downstream Blast Radius (+0.15)

```typescript
const downstreamFailing = edges
  .filter(e => e.source === node.id)
  .filter(e => {
    const target = nodes.find(n => n.id === e.target);
    return target && (target.status === 'critical' || target.status === 'degraded');
  });

if (downstreamFailing.length > 0) {
  score += 0.15;  // More downstream failures = higher root cause probability
}
```

**Rationale:** A true root cause will have cascading downstream failures. A node that's failing in isolation is less likely to be the origin of a cascade.

### Confidence Mapping

| Score | Confidence |
|---|---|
| ≥ 0.75 | `HIGH` |
| ≥ 0.50 | `MEDIUM` |
| > 0.00 | `LOW` |
| 0.00 | `UNKNOWN` |

---

## Propagation Path — BFS

```typescript
private buildPropagationPath(rootCause: ServiceNode, nodes: ServiceNode[], edges: DependencyEdge[]): PropagationStep[] {
  const visited = new Set([rootCause.id]);
  const queue = [rootCause.id];
  const steps: PropagationStep[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    // Only traverse observed edges — declared-only paths are not confirmed
    const outgoing = edges.filter(e => e.source === currentId && e.observed);
    for (const edge of outgoing) {
      const target = nodes.find(n => n.id === edge.target);
      if (!target || visited.has(target.id)) continue;
      visited.add(target.id);
      steps.push({ sourceId: currentId, targetId: target.id, edgeId: edge.id, ... });
      if (target.status === 'critical' || target.status === 'degraded') {
        queue.push(target.id);  // Continue traversal from failing nodes
      }
    }
  }
  return steps;
}
```

**Only observed edges in propagation:** Traversing declared-only edges would follow theoretical architecture paths. We only follow paths where we've actually seen traffic — those are the real propagation routes.

---

## Supporting Components

### `TemporalAnalyzer`

Builds a timeline from `AnomalyRecord[]` objects:

```typescript
buildTimeline(anomalies: AnomalyRecord[]): AnomalyRecord[] {
  return [...anomalies].sort((a, b) =>
    new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime()
  );
}

findEarliestAnomalousNode(anomalies: AnomalyRecord[]): string | null {
  const sorted = this.buildTimeline(anomalies);
  return sorted[0]?.nodeId ?? null;
}
```

### `ExplanationEngine`

Generates a structured natural-language explanation from RCA results:

```typescript
generateExplanation(params: ExplanationParams): RCAExplanation {
  return {
    whatHappened: `${params.affectedServices.length} services are experiencing issues`,
    whenStarted: params.incidentStartedAt,
    likelyRootCause: params.primaryRootCause?.name ?? 'Unknown',
    why: this.buildWhyNarrative(params),
    propagationPath: params.propagationPath.map(s => `${s.sourceId} → ${s.targetId}`),
    affectedServices: params.affectedServices.map(s => s.name),
    confidence: params.confidence,
    alternativeCandidates: params.alternativeCandidates.map(c => ({
      name: c.node.name, score: c.score, confidence: c.confidence
    })),
    evidenceSummary: params.evidence.map(e => e.description),
    recommendedInvestigation: this.buildRecommendations(params),
  };
}
```

### `AnomalyDetector`

Reads `ml/data/latest_scores.json` and converts them to `AnomalyRecord[]`:

```typescript
getAnomalies(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
  const scores = readScoresFromDisk();
  return nodes
    .filter(n => n.project === targetId && scores[n.id]?.anomaly_score > threshold)
    .map(n => ({
      nodeId: n.id,
      targetId,
      score: scores[n.id].anomaly_score,
      persistent: scores[n.id].persistent,
      detectedAt: new Date().toISOString(),
    }));
}
```

---

## `IncidentManager` — Lifecycle

```
NORMAL → INCIDENT → RECOVERING → RESOLVED
           ↑                         ↓
           └────── re-opened ─────── ┘ (if failure re-detected during RECOVERING)
```

### Deduplication

Only one incident per target is tracked at a time. If `evaluateTarget()` fires again while an incident is active for the same target, the existing incident is **updated in place** (symptoms appended, confidence refreshed, timestamp updated) rather than creating a duplicate.

### History

Resolved incidents are kept in an in-memory list (last N per target) for display in `RCAView`. They are not persisted to disk between restarts.

# core: the analysis logic

Everything that decides *what is wrong* lives here. Nothing in this folder draws a screen, and nothing outside it contains an algorithm.

```
core/
├── algo.py                 PURE ALGORITHMS: graph helpers, detection, root-cause attribution, cascade risk. numpy/pandas only.
├── preprocessing/          DATA PREPARATION: raw rows -> the cube X[tick, service, feature]
│   ├── spec.py             which direction means trouble, which scale, own vs inheritable evidence, per feature
│   └── prepare.py          counters -> rates, restart and gap handling, container_up, name matching
├── ml/                     ML PIPELINE (optional side path): collector, preprocess, train, score (Isolation Forest, LOF, One-Class SVM, z-score)
├── evaluation/             THE EVIDENCE: labelled-fault bench (bench.py), tables and the real-crash replay (reports.py), `python -m core.evaluation`
├── live.py                 live data: polls the graph service, keeps a time series per target, runs the algorithms
├── incidents.py            shapes the algorithms' output into the incident the UI reads (presentation only, no new numbers)
├── service.py              HTTP service on :8000 (/api/core/analysis, /incidents, /evaluation, /real-crash, /health)
├── data/                   the bench's healthy traffic, the real-crash recording, the DeathStar call graph
└── tests/                  reproduce the report's numbers; guard algo.py's purity; run the live path against a simulated target
```

## The pipeline

```
raw rows ──► preprocessing.prepare ──► algo.score ──► algo.normalise / calibrate / flags_for ──► algo.attribute ──► algo.risk ──► incidents.build_incident
 (CSV,        cube X[t, service, f]     z-scores vs     per-series noise, threshold from a        who broke first    who is next      what the UI reads
  samples,    counters -> rates,        each service's  false-alarm budget, persistence           (own vs inherited)
  graph API)  container_up              own recent past
```

| step | function (`core/algo.py`) | idea |
|---|---|---|
| detect | `score` | robust z-score against the service's **own** recent past: median/MAD, log scale, bad direction only, self-healing baseline (an anomaly never becomes the baseline), common-mode removal (a shared burst is load, not a fault), a **silence** signal for services that stop reporting |
| threshold | `normalise`, `calibrate`, `flags_for` | per-series noise shrinking; tau is the smallest threshold whose healthy-history alarms stay under a false-alarm budget; a service is flagged after `persistence` consecutive ticks |
| blame | `attribute` | score = max(own evidence, symptoms no callee already explains) + 100 for a stopped container. A victim's symptoms are explained by its broken callee; the source's are not |
| predict | `risk` | healthy callers of a failing service, by severity times edge probability |
| graph | `compose_edges`, `edges_from_graph`, `merge_edges`, `callers_of` | `(caller, callee)` pairs from a compose file or the graph service's evidence-tagged edges |

**Provenance.** `algo.py`'s detection, attribution and cascade code, `preprocessing/` and `evaluation/bench.py` are the research notebook's code
(`colab/rca_research_src.py` in the research repository), the same code the statistical report measured. `core/tests` pin the report's numbers,
so a change that alters the method fails a test. Added since, each covered by a test: `live_threshold` and `alarm_window` (live use without a fault
ledger), the graph helpers, and `prepare(down_ticks=...)` (a vanished container stays "down" in live use; the default is the measured behaviour).

## Run

```bash
pip install -r ../requirements.txt
python -m core                      # service on :8000; needs the graph service on :3001 (CORE_NODE_URL to change)
python -m core.evaluation           # recompute docs/EVALUATION.md
python -m pytest core/tests -q
```

Environment: `CORE_NODE_URL` (graph service, default `http://localhost:3001`), `CORE_DATA_DIR` (where live samples are kept),
`CORE_PERSIST=0` (keep samples in memory only), `CORE_STEP` and `CORE_FRESH_S` (tick length and freshness window; shortened by the end-to-end test).

## Limits you should know

* **Slow faults** are barely visible (about 16% root-first); **frozen services** are detected but, with SSH-level data alone, not localised.
* The live threshold is calibrated on the first 30 minutes of history. Start the system healthy.
* Without traces the core sees CPU, memory, network and container presence. Latency and error rates are not used unless a source provides them.
* Edge probabilities in cascade risk are the structural prior (0.5). Learning them across incidents helped on a 17-service app and was unclear at 100 services, so it is not used.

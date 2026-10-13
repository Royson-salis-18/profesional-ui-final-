# Which version of the analysis was chosen, and why

The work existed in several places. For the part that decides *what is wrong*, the choice was made on measured accuracy, not on which code
was newest.

## What was compared

All three were run on **the same 751 labelled faults** (seeds 3 to 22 of the bench in `core/evaluation/bench.py`: 77 minutes of real
OpenTelemetry traffic stretched to 10 hours, with slow / error / crash / hang faults injected at known times). "Root first" means the true
root cause is ranked first among all services.

| version | where it was | root first | top 3 | false alarms / h | how this number was obtained |
|---|---|---|---|---|---|
| **Research method** (chosen) | `new-repo/colab/rca_research_src.py` | **69.5%** (66.2 to 72.5) | **76.8%** | 0.17 | `python -m core.evaluation` |
| Previous lab method, "full" | `new-repo/rcalab` (now `archive/lab-v1`) | 39.0% | 40.7% | 0.0 | `python archive/lab-v1/compare_with_core.py` |
| Previous lab method, "selftime" (the lab's old default) | same | 27.2% | 39.5% | 0.0 | same |
| Previous lab method, "most abnormal" | same | 39.7% | 40.7% | 0.0 | same |
| Original notebook method | `new-repo/colab/original.ipynb` | 45.4% | 52.5% | 79.7 | `python -m core.evaluation` |
| Random ranking | | 6.9% | 20.8% | | `python -m core.evaluation` |
| Rule-based incident engine | `microservice-mapper/server/rca/*.ts` | **not measured** | | | see below |

Reading the table honestly:

* The previous lab method detects the faulty service in only about 41% of faults (its top-3 equals its recall), which is why its false alarms are
  zero and its accuracy low. Its ranking only orders *flagged* services, so its "random" baseline scores 28% instead of 7%; compare the previous
  lab rows with each other, and with the research method, with that in mind. It cannot rank a service it never flagged.
* On this bench the research method is **not** better than simply picking the most abnormal service (70.3%); explain-away attribution adds nothing
  measurable here. What carries it is the **silence signal** (without it, 45.0%) and **per-series noise normalisation** (without it, 60.3% and
  1.27 false alarms an hour). See `docs/EVALUATION.md`.
* The rule-based incident engine in the graph service was never evaluated against labelled faults: it has unit tests (`tests/rca*.test.ts`) and
  was corrected after live tests showed it rewarded victims, but no accuracy figure exists for it. It cannot be compared, so it is kept only as
  the **fallback** shown while the core is offline or still collecting history.

## What each repository contributes

| repository | role in the final project |
|---|---|
| `new-repo` | the research method and its evidence -> `core/` (algorithms, preprocessing, evaluation, data); the report -> `docs/` |
| `microservice-mapper` | the graph service, UI, ML pipeline, traffic generator -> `server/`, `client/`, `core/ml/`, `traffic-gen/` |
| `bench-1`, `bench-2` | test applications with fault scenarios and written ground truth; kept as separate repositories, linked from the README |

## Not part of the comparison

* The **ML pipeline** (`core/ml`: Isolation Forest, LOF, One-Class SVM per service) has no labelled evaluation either; on idle containers it
  mostly stays quiet (one service had 1568 training rows holding six distinct values). It is kept as an optional second opinion, shown under
  Findings, and does not feed incidents.
* **Cascade prediction** cannot be validated on this bench, because the bench spreads faults along the same call graph the predictor uses
  (any graph-based predictor scores about 0.99 by construction). On services not yet alarmed the online risk score reaches AUC 0.68.
* **One real fault** (a container stopped on AWS, ranked #1 of 27) is a demonstration, not a statistic.

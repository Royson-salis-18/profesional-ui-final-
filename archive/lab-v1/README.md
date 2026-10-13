# lab-v1 (archived)

The first RCA lab: a Python package (`rcalab/`), a FastAPI server (`server.py`) and a single-page Live / Lab UI (`static/index.html`).
It is **not connected** to the app. It was replaced by `core/` because its ranking method measured worse on the same labelled faults
(see `docs/VERSION_CHOICE.md`). It is kept because:

* `compare_with_core.py` reproduces that comparison: `python archive/lab-v1/compare_with_core.py` (from the repo root);
* its single-page UI (bench replay, four-step Map / Notice / Blame / Predict story, projects and EC2 import) may be worth reviving.

Run it standalone with `pip install -r requirements.txt && python server.py` from this folder.

#!/usr/bin/env python3
"""
Trains one Isolation Forest per service on that service's own normalized
features, on the assumption that most of the collected window is normal
behavior and true anomalies are rare (contamination is set explicitly, not
'auto', so it's reproducible and reportable).

This is unsupervised: there's no "normal" label to filter on, so if you ran
stress/failure experiments while the collector was running, that traffic is
mixed into the training data and will teach the model that stress looks
normal. Best practice, and what --since is for: point training at a time
range you know was baseline-only.

Persists, per service:
  models/<service_id>.joblib        the fitted IsolationForest
  models/<service_id>.meta.json     feature column order + threshold (99th
                                     percentile of this service's own
                                     training scores) — both required to
                                     score new data consistently later.
"""

import argparse
import json
import os
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor
from sklearn.svm import OneClassSVM

from mlconfig import ALL_FEATURE_COLUMNS, load_config

FEATURES_PATH = os.path.join(os.path.dirname(__file__), "data", "features.csv")
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

_cfg = load_config()
MIN_TRAINING_SAMPLES = _cfg["min_training_samples"]
CONTAMINATION = _cfg["contamination"]  # explicit, not 'auto' — must be reproducible for the paper
FEATURE_COLUMNS = [c for c in _cfg["feature_columns"] if c in ALL_FEATURE_COLUMNS] or list(ALL_FEATURE_COLUMNS)


# ---------------------------------------------------------------- detectors
#
# Every detector returns "higher = more anomalous" so thresholds, holdout
# numbers and cross-model agreement are all comparable. The sklearn
# estimators natively score the other way round (higher = more normal), so
# each one is negated at the point it is read, never later.
#
# These are deliberately different *families*, because agreeing detectors
# are only informative when they could have disagreed:
#   iforest  partitioning    — cheap, handles mixed scales, the existing default
#   lof      local density   — catches a point normal globally but odd locally
#   ocsvm    boundary        — fits a frontier around the normal region
#   zscore   statistical     — no fitting at all; the features are already
#                              z-scores, so this is max|z| across them, and it
#                              is the interpretable baseline the others have
#                              to beat before anyone trusts them.


def _fit_iforest(X, contamination, n_estimators, max_samples):
    model = IsolationForest(
        n_estimators=n_estimators,
        max_samples=max_samples,
        contamination=contamination,
        random_state=42,
    )
    model.fit(X)
    return model, lambda m, data: -m.decision_function(data)


def _fit_lof(X, contamination, **_):
    # novelty=True is required to score data the model was not fitted on.
    # n_neighbors cannot exceed the sample count.
    #
    # LOF needs genuinely distinct neighbours. When a point's k nearest
    # neighbours are all identical to it, its local reachability density is
    # effectively infinite and the LOF score explodes: fitting this data
    # as-is produced thresholds of 3.37e9 for death-star:user-mongodb, and
    # sock-shop:carts — 1568 rows with 6 distinct values — flagged 100% of
    # its holdout. Those are artefacts of duplicate rows, not detections.
    # Refusing to fit is the honest outcome; a model nobody can trust is
    # worse than an absent one, and the reason is recorded in the metadata.
    # Fit on distinct rows. The duplication here is a sampling artefact —
    # the collector polls every 10s while docker stats updates less often,
    # so the same state is recorded over and over (1568 rows carrying 47
    # distinct values on death-star:social-graph-mongodb). Real density
    # would be worth modelling; a repeated sample is not, and it is what
    # drives the score to infinity, since a point's 20 nearest neighbours
    # are then 20 copies of itself at distance 0. Fitting on distinct rows
    # took that service's threshold from 2.48e9 to a usable number.
    #
    # Scoring is still done on every row; only the fit is deduplicated.
    X_unique = np.unique(X, axis=0)
    # A floor, not just "more distinct rows than neighbours". Allowing the
    # neighbourhood to shrink to fit tiny data produces a model that fits
    # and is still meaningless: on sock-shop, 6 distinct rows gave a 5-
    # neighbour LOF that fired on 84.6% of its holdout. Density needs a
    # neighbourhood of genuinely distinct points, so refuse below 20 and say
    # why rather than emit a detector nobody should act on.
    LOF_MIN_DISTINCT = 20
    if len(X_unique) < LOF_MIN_DISTINCT:
        raise ValueError(
            f"only {len(X_unique)} distinct feature rows (need {LOF_MIN_DISTINCT}) — "
            "too little distinct structure for a density model"
        )
    n_neighbors = int(min(20, len(X_unique) - 1))
    model = LocalOutlierFactor(n_neighbors=n_neighbors, contamination=contamination, novelty=True)
    model.fit(X_unique)
    return model, lambda m, data: -m.score_samples(data)


def _fit_ocsvm(X, contamination, **_):
    # nu is roughly the expected outlier fraction, so contamination maps onto
    # it directly. Clamped because nu must be in (0, 1].
    nu = float(min(max(contamination, 1e-4), 0.5))
    model = OneClassSVM(kernel="rbf", gamma="scale", nu=nu)
    model.fit(X)
    return model, lambda m, data: -m.decision_function(data)


class ZScoreDetector:
    """max|z| across the feature columns. Fitted only in the sense that it
    records what it was built from; the features are already normalised
    upstream by preprocess.py, so there is nothing to learn here. Kept as a
    real model object so it is saved, loaded and scored exactly like the
    others."""

    def __init__(self, feature_columns):
        self.feature_columns = list(feature_columns)

    def score(self, data):
        return np.max(np.abs(np.asarray(data, dtype=float)), axis=1)


def _fit_zscore(X, contamination, **_):
    model = ZScoreDetector(FEATURE_COLUMNS)
    return model, lambda m, data: m.score(data)


DETECTORS = {
    "iforest": _fit_iforest,
    "lof": _fit_lof,
    "ocsvm": _fit_ocsvm,
    "zscore": _fit_zscore,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", help="ISO timestamp; only train on rows at or after this time (use to exclude known stress/failure windows)")
    parser.add_argument("--until", help="ISO timestamp; only train on rows at or before this time")
    parser.add_argument("--contamination", type=float, default=CONTAMINATION)
    parser.add_argument("--min-samples", type=int, default=MIN_TRAINING_SAMPLES)
    parser.add_argument(
        "--algorithms",
        default=",".join(DETECTORS),
        help=f"comma-separated subset of: {', '.join(DETECTORS)} (default: all)",
    )
    parser.add_argument(
        "--project",
        help="train only this project's services (service_id prefix before ':'). "
             "Models are per service and never mixed across projects, so this "
             "changes which are rebuilt, not what any of them learns.",
    )
    parser.add_argument("--n-estimators", type=int, default=int(_cfg["n_estimators"]))
    parser.add_argument("--holdout-fraction", type=float, default=float(_cfg["holdout_fraction"]))
    args = parser.parse_args()

    algorithms = [a.strip() for a in args.algorithms.split(",") if a.strip()]
    unknown = [a for a in algorithms if a not in DETECTORS]
    if unknown:
        print(f"[train] unknown algorithm(s): {', '.join(unknown)}; known: {', '.join(DETECTORS)}", file=sys.stderr)
        sys.exit(2)
    # iforest first so its artifact and the top-level meta fields — which
    # every existing reader depends on — are written even if a later
    # detector blows up on this service.
    algorithms.sort(key=lambda a: 0 if a == "iforest" else 1)
    min_training_samples = args.min_samples
    n_estimators = int(args.n_estimators)
    max_samples_fraction = float(_cfg["max_samples_fraction"])
    holdout_fraction = float(args.holdout_fraction)

    if not os.path.exists(FEATURES_PATH):
        print(f"[train] no features at {FEATURES_PATH} — run preprocess.py first", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(FEATURES_PATH, parse_dates=["timestamp"])
    if args.since:
        since = pd.Timestamp(args.since, tz="UTC")
        df = df[df["timestamp"] >= since]
    if args.until:
        until = pd.Timestamp(args.until, tz="UTC")
        df = df[df["timestamp"] <= until]

    if args.project:
        prefix = f"{args.project}:"
        before = df["service_id"].nunique()
        df = df[df["service_id"].astype(str).str.startswith(prefix)]
        if df.empty:
            print(
                f"[train] no rows for project '{args.project}' "
                f"(features.csv holds {before} service(s))",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"[train] scoped to project '{args.project}': {df['service_id'].nunique()} service(s)")

    os.makedirs(MODELS_DIR, exist_ok=True)

    trained, skipped = [], []

    for service_id, group in df.groupby("service_id"):
        clean = group.dropna(subset=FEATURE_COLUMNS).sort_values("timestamp")
        if len(clean) < min_training_samples:
            skipped.append((service_id, len(clean)))
            continue

        # Chronological (not random) split: the tail is held out so the
        # evaluation answers "how does this model behave on data collected
        # after it was fitted", which is how it's actually used at scoring
        # time. A random split would leak adjacent samples across the
        # boundary and make the number look better than it is.
        n_holdout = int(len(clean) * holdout_fraction)
        if n_holdout < 1 or len(clean) - n_holdout < min_training_samples:
            n_holdout = 0  # not enough data to spare; train on everything
        fit_rows = clean.iloc[: len(clean) - n_holdout] if n_holdout else clean
        holdout_rows = clean.iloc[len(clean) - n_holdout :] if n_holdout else None

        X = fit_rows[FEATURE_COLUMNS].to_numpy()
        X_holdout = holdout_rows[FEATURE_COLUMNS].to_numpy() if holdout_rows is not None and len(holdout_rows) > 0 else None
        max_samples = "auto" if max_samples_fraction >= 1.0 else max(1, int(len(X) * max_samples_fraction))
        safe_name = service_id.replace("/", "_").replace(":", "_")

        # How much distinct signal is actually in here? Collecting every 10s
        # from a service whose metrics barely move produces mostly repeated
        # rows, and a detector cannot learn a boundary from a handful of
        # distinct points however many times they are repeated. This is the
        # first number to look at when every model flags 0%: measured on
        # sock-shop:carts, 1568 rows contained 6 distinct values.
        unique_rows = int(len(np.unique(X, axis=0)))
        data_quality = {
            "rows": int(len(X)),
            "unique_rows": unique_rows,
            "unique_fraction": float(unique_rows / len(X)) if len(X) else 0.0,
            "feature_std": {c: float(v) for c, v in zip(FEATURE_COLUMNS, X.std(axis=0))},
        }

        per_algo = {}
        holdout_flags = {}  # algo -> boolean mask over the holdout, for agreement

        for algo in algorithms:
            try:
                model, score_fn = DETECTORS[algo](
                    X,
                    contamination=args.contamination,
                    n_estimators=n_estimators,
                    max_samples=max_samples,
                )
            except Exception as exc:  # one detector failing must not lose the others
                per_algo[algo] = {"error": f"{type(exc).__name__}: {exc}"}
                print(f"  [{service_id}] {algo} failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                # Drop any artifact from an earlier run. Leaving it behind
                # means the metadata says "refused" while a loadable model
                # sits on disk next to it, and a scorer that globs for
                # artifacts would happily use the stale one — which is how
                # you end up acting on a detector you already decided not
                # to trust.
                suffix = "" if algo == "iforest" else f".{algo}"
                stale = os.path.join(MODELS_DIR, f"{safe_name}{suffix}.joblib")
                if os.path.exists(stale):
                    os.remove(stale)
                    print(f"  [{service_id}] removed stale {algo} artifact", file=sys.stderr)
                continue

            # Threshold comes from this service's own training distribution,
            # not a hard-coded guess, and is per algorithm because the score
            # scales are not comparable across families.
            raw_scores = score_fn(model, X)
            threshold_99 = float(np.percentile(raw_scores, 99))

            holdout_eval = None
            if X_holdout is not None:
                holdout_scores = score_fn(model, X_holdout)
                flags = holdout_scores >= threshold_99
                holdout_flags[algo] = flags
                holdout_eval = {
                    "samples": int(len(X_holdout)),
                    # Unlabelled data, so this is a firing rate, not accuracy.
                    "flag_rate": float(np.mean(flags)),
                    "mean_score": float(np.mean(holdout_scores)),
                    "max_score": float(np.max(holdout_scores)),
                    "from": holdout_rows["timestamp"].iloc[0].isoformat(),
                    "to": holdout_rows["timestamp"].iloc[-1].isoformat(),
                }

            suffix = "" if algo == "iforest" else f".{algo}"
            joblib.dump(model, os.path.join(MODELS_DIR, f"{safe_name}{suffix}.joblib"))

            per_algo[algo] = {
                "threshold_p99": threshold_99,
                "train_score_mean": float(np.mean(raw_scores)),
                "train_score_max": float(np.max(raw_scores)),
                "holdout": holdout_eval,
                "artifact": f"{safe_name}{suffix}.joblib",
            }

        # How often do the detectors agree on the same holdout rows? Two
        # detectors that always agree add no information over one; two that
        # never agree mean at least one is not measuring what we think. This
        # is the number that says whether running four was worth it.
        agreement = {}
        algo_names = sorted(holdout_flags)
        for i, a in enumerate(algo_names):
            for b in algo_names[i + 1:]:
                fa, fb = holdout_flags[a], holdout_flags[b]
                both = int(np.sum(fa & fb))
                either = int(np.sum(fa | fb))
                agreement[f"{a}|{b}"] = {
                    # Fraction of rows both call the same thing, flagged or not.
                    "same_verdict_rate": float(np.mean(fa == fb)),
                    # Of the rows anyone flagged, how many did both flag.
                    "jaccard": float(both / either) if either else None,
                    "both_flagged": both,
                    "either_flagged": either,
                }

        iforest = per_algo.get("iforest", {})
        with open(os.path.join(MODELS_DIR, f"{safe_name}.meta.json"), "w") as f:
            json.dump({
                "service_id": service_id,
                "project": service_id.split(":")[0] if ":" in service_id else None,
                "feature_columns": FEATURE_COLUMNS,
                "trained_on_samples": int(len(fit_rows)),
                "trained_at": pd.Timestamp.now('UTC').isoformat(),
                "contamination": args.contamination,
                "n_estimators": n_estimators,
                "max_samples": max_samples,
                # Top-level fields stay on iforest so every existing reader
                # (score.py, /api/ml/models, the UI) keeps working unchanged.
                "threshold_p99": iforest.get("threshold_p99"),
                "train_score_mean": iforest.get("train_score_mean"),
                "train_score_max": iforest.get("train_score_max"),
                "holdout": iforest.get("holdout"),
                "algorithms": per_algo,
                "agreement": agreement,
                "data_quality": data_quality,
                "training_window": {
                    "since": args.since,
                    "until": args.until,
                },
            }, f, indent=2)

        trained.append((service_id, int(len(fit_rows)), iforest.get("threshold_p99"), iforest.get("holdout"), per_algo, data_quality))

    print(f"[train] trained {len(trained)} service(s) x {len(algorithms)} detector(s): {', '.join(algorithms)}")
    print(f"[train] features: {', '.join(FEATURE_COLUMNS)}")
    print(f"[train] n_estimators={n_estimators} max_samples_fraction={max_samples_fraction} holdout_fraction={holdout_fraction}")
    for sid, n, thr, hold, per_algo, dq in trained:
        thr_txt = f"{thr:.4f}" if isinstance(thr, float) else "n/a"
        extra = f", holdout {hold['samples']} rows flagged {hold['flag_rate'] * 100:.1f}%" if hold else ", no holdout (too few rows)"
        warn = "  <-- little distinct signal" if dq["unique_fraction"] < 0.05 else ""
        print(f"  {sid}: {n} samples ({dq['unique_rows']} distinct, {dq['unique_fraction'] * 100:.1f}%){warn}")
        print(f"      iforest threshold_p99={thr_txt}{extra}")
        for algo in algorithms:
            info = per_algo.get(algo)
            if not info:
                continue
            if "error" in info:
                print(f"      {algo:<8} FAILED: {info['error']}")
                continue
            h = info.get("holdout")
            rate = f"{h['flag_rate'] * 100:.1f}% of {h['samples']}" if h else "no holdout"
            print(f"      {algo:<8} threshold={info['threshold_p99']:.4f}  holdout flagged {rate}")

    if skipped:
        print(f"[train] skipped {len(skipped)} services with < {min_training_samples} samples:")
        for sid, n in skipped:
            print(f"  {sid}: {n} samples")

    summary = {
        "generated_at": pd.Timestamp.now('UTC').isoformat(),
        "min_training_samples": min_training_samples,
        "contamination": args.contamination,
        "n_estimators": n_estimators,
        "max_samples_fraction": max_samples_fraction,
        "holdout_fraction": holdout_fraction,
        "feature_columns": FEATURE_COLUMNS,
        "training_window": {"since": args.since, "until": args.until},
        "project": args.project,
        "algorithms": algorithms,
        "trained": {
            sid: {
                "samples": n,
                "project": sid.split(":")[0] if ":" in sid else None,
                "threshold_p99": thr,
                "holdout": hold,
                "data_quality": dq,
                "algorithms": {
                    a: {
                        "threshold_p99": info.get("threshold_p99"),
                        "holdout_flag_rate": (info.get("holdout") or {}).get("flag_rate"),
                        "error": info.get("error"),
                    }
                    for a, info in per_algo.items()
                },
            }
            for sid, n, thr, hold, per_algo, dq in trained
        },
        "skipped": {sid: {"samples": n} for sid, n in skipped},
    }
    # A project-scoped run must not erase the record of the others. The
    # summary is what the UI reads to decide whether a service has a model,
    # so overwriting it wholesale after training one project would show every
    # other project as untrained while its models sat on disk, fine.
    summary_path = os.path.join(MODELS_DIR, "training_summary.json")
    if args.project and os.path.exists(summary_path):
        try:
            with open(summary_path) as f:
                previous = json.load(f)
        except (json.JSONDecodeError, OSError):
            previous = {}

        def _other_projects(section):
            prefix = f"{args.project}:"
            return {
                sid: entry
                for sid, entry in (previous.get(section) or {}).items()
                if not str(sid).startswith(prefix)
            }

        summary["trained"] = {**_other_projects("trained"), **summary["trained"]}
        summary["skipped"] = {**_other_projects("skipped"), **summary["skipped"]}
        # Keep a per-project record of when each was last trained, so "this
        # project is stale" is answerable without re-reading every model file.
        last_trained = dict(previous.get("last_trained_per_project") or {})
        last_trained[args.project] = summary["generated_at"]
        summary["last_trained_per_project"] = last_trained
    else:
        summary["last_trained_per_project"] = {
            p: summary["generated_at"]
            for p in {sid.split(":")[0] for sid in summary["trained"] if ":" in sid}
        }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    if not trained:
        print("[train] nothing trained — need more data or a wider --since/--until window", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

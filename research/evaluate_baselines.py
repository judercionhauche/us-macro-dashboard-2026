"""Fit A1 and score A0/A1 only after verifying the frozen label file."""
import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd

from research.baselines import altman_predictions, fit_logistic, logistic_predictions
from research.metrics import cluster_auroc, score


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=Path("results"))
    args = parser.parse_args()
    root = args.results
    labels = root / "labels.csv"
    digest = hashlib.sha256(labels.read_bytes()).hexdigest()
    if digest not in (root / "run_log.md").read_text(encoding="utf-8"):
        raise ValueError("Labels do not match the frozen SHA-256")
    keys = ["cik", "cutoff"]
    panel = pd.read_csv(root / "panel.csv").merge(
        pd.read_csv(labels).drop(columns="ticker"), on=keys, how="inner", validate="one_to_one"
    ).sort_values(keys)
    train = panel[panel["split"] == "train"]
    validation = panel[panel["split"] == "val"]
    test = panel[panel["split"] == "test"]
    model, c, threshold = fit_logistic(train, validation)
    a0 = altman_predictions(test)
    a1 = logistic_predictions(model, threshold, test)
    comparable = a0["score"].notna()
    predictions = pd.DataFrame({
        "cik": test["cik"], "cutoff": test["cutoff"], "positive": test["positive"],
        "A0_score": a0["score"], "A0_high": a0["high"],
        "A1_score": a1["score"], "A1_high": a1["high"],
    })
    predictions.to_csv(root / "baseline_predictions.csv", index=False)
    y = test.loc[comparable, "positive"]
    intervals, _, skipped = cluster_auroc(
        y, test.loc[comparable, "cik"],
        {"A0": a0.loc[comparable, "score"], "A1": a1.loc[comparable, "score"]}, [],
    )
    preliminary = {
        "auroc_95_cluster_intervals": intervals, "bootstrap_skipped": skipped,
        "LR_C": c, "threshold": threshold, "test_rows": len(test),
        "common_baseline_rows": len(y),
        "A0": score(y, a0.loc[comparable, "score"], a0.loc[comparable, "high"].astype(bool)),
        "A1": score(y, a1.loc[comparable, "score"], a1.loc[comparable, "high"],
                    a1.loc[comparable, "score"]),
    }
    (root / "preliminary_baselines.json").write_text(
        json.dumps(preliminary, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(preliminary, indent=2))


if __name__ == "__main__":
    main()

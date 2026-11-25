"""Build the historical evidence shared by the Risk Lab API and static site."""
import argparse
import csv
import json
from pathlib import Path

import pandas as pd


RESULTS = Path(__file__).resolve().parent.parent / "results"


def study_payload():
    sample = pd.read_csv(RESULTS / "sample.csv")
    panel = pd.read_csv(RESULTS / "panel.csv")
    labels = pd.read_csv(RESULTS / "labels.csv")
    columns = ["cik", "cutoff", "net_margin", "debt_assets", "ocf_margin"]
    history = panel[columns].merge(labels[["cik", "cutoff", "positive"]],
                                   on=["cik", "cutoff"], how="left", validate="one_to_one")
    return {
        "sample": sample.to_dict("records"),
        "history": json.loads(history.to_json(orient="records")),
        "metrics": json.loads((RESULTS / "preliminary_baselines.json").read_text()),
        "total": len(labels), "positive": int(labels["positive"].sum()),
    }


def write_study(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(study_payload(), allow_nan=False, separators=(",", ":")) + "\n")


def write_benchmark(path):
    source = RESULTS / "human_benchmark"
    summary = json.loads((source / "summary.json").read_text())
    shared = summary["shared"]
    with (source / "pilot_audited_outcomes.csv").open(newline="") as stream:
        cases = {
            row["cik"]: {
                "grade": row["fitch_grade"] if row["match_status"] == "scored" else None,
                "action_date": row["rating_action_date"] if row["match_status"] == "scored" else None,
                "event": row["observed_distress"] == "1",
                "corrected": row["observed_distress"] != row["frozen_distress"],
            }
            for row in csv.DictReader(stream)
            if row["cutoff"] == summary["prediction_date"]
        }
    data = {
        "cutoff": summary["prediction_date"],
        "archive_date": summary["archive_date"],
        "companies": shared["companies"],
        "events": shared["events"],
        "fitch_auroc": shared["metrics"]["Fitch"]["auroc"],
        "debate_auroc": shared["metrics"]["debate"]["auroc"],
        "cases": cases,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, allow_nan=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=RESULTS / "risk_study.json")
    parser.add_argument("--benchmark-output", type=Path, default=RESULTS / "risk_benchmark.json")
    options = parser.parse_args()
    write_study(options.output)
    write_benchmark(options.benchmark_output)

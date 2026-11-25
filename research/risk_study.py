"""Build the historical evidence shared by the Risk Lab API and static site."""
import argparse
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=RESULTS / "risk_study.json")
    write_study(parser.parse_args().output)

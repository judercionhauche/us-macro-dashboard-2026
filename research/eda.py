"""Compute the milestone's label summary and exploratory figure."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from scipy.stats import mannwhitneyu


EDA_FEATURES = {
    "CR": "current_ratio", "DA": "debt_assets", "IC": "interest_coverage",
    "NM": "net_margin", "OD": "ocf_debt", "RG": "revenue_growth_yoy", "Z": "altman_z",
}


def label_summary(joined):
    keys = {}
    for split in ("train", "val", "test", "all"):
        rows = joined if split == "all" else joined[joined["split"] == split]
        n = len(rows)
        positives = int(rows["positive"].sum())
        keys[f"N_{split.upper()}"] = str(n)
        keys[f"POS_{split.upper()}"] = f"{positives} ({positives/n:.1%})"
        for event in ("e1", "e2", "e3"):
            keys[f"{event.upper()}_{split.upper()}"] = str(int(rows[event].sum()))
    for abbr, col in EDA_FEATURES.items():
        negative = joined.loc[joined["positive"] == 0, col].dropna()
        positive = joined.loc[joined["positive"] == 1, col].dropna()
        keys[f"M_{abbr}_0"] = f"{negative.median():.3g}"
        keys[f"M_{abbr}_1"] = f"{positive.median():.3g}"
        keys[f"M_{abbr}_P"] = f"{mannwhitneyu(negative, positive).pvalue:.3g}"
    return keys


def figure(joined, sample, out):
    fig, (left, right) = plt.subplots(1, 2, figsize=(10, 4), layout="constrained")
    quarter = joined.groupby("cutoff")[["positive", "e1", "e2", "e3"]].mean()
    for column, label in zip(quarter.columns, ("Any event", "E1", "E2", "E3")):
        left.plot(pd.to_datetime(quarter.index), quarter[column] * 100, label=label)
    year_ends = pd.to_datetime([d for d in quarter.index if d.endswith("-12-31")])
    left.set_xticks(year_ends, year_ends.year)
    left.set_xlabel("Year-end cutoffs")
    left.legend(frameon=False)
    left.set_ylabel("Observations (%)")
    counts = sample.groupby("sector").size().sort_values()
    rates = joined.groupby("sector")["positive"].mean()
    right.barh(counts.index, counts.values, color="#365a7c")
    right.set_xlabel("Companies sampled")
    right.set_xlim(0, max(counts) * 1.35)
    for index, sector in enumerate(counts.index):
        right.text(counts[sector] + .25, index, f"{rates[sector]:.1%}", va="center")
    fig.savefig(out, dpi=200)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=Path("results"))
    args = parser.parse_args()
    root = args.results
    panel = pd.read_csv(root / "panel.csv")
    labels = pd.read_csv(root / "labels.csv").drop(columns="ticker")
    joined = labels.merge(panel, on=["cik", "cutoff"], validate="one_to_one")
    sample = pd.read_csv(root / "sample.csv")
    (root / "figures").mkdir(exist_ok=True)
    figure(joined, sample, root / "figures" / "fig2.png")
    summary = label_summary(joined)
    summary["MISSING_PCT"] = f"{1-len(panel)/(25*len(sample)):.1%}"
    (root / "eda_values.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()

"""Evaluate all arms on the same completed observations with paired intervals."""
import argparse
import json
from pathlib import Path

import pandas as pd

from research.agents import check_claim
from research.arm_figures import figures
from research.metrics import cluster_auroc, score
from research.run_agents import load_jsonl


COMPARISONS = (("B", "A1"), ("C", "B"), ("E", "C"), ("D", "E"), ("D", "C"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--tool-grounded", action="store_true")
    args = parser.parse_args()
    root = args.results
    baseline = pd.read_csv(root / "baseline_predictions.csv").set_index(["cik", "cutoff"])
    source = "grounded_llm_predictions.jsonl" if args.tool_grounded else "llm_predictions.jsonl"
    records = load_jsonl(root / source)
    packets = {(row["cik"], row["cutoff"]): row for row in load_jsonl(root / "packets.jsonl")}
    completed = sorted((r for r in records if "result" in r), key=lambda r: (r["cik"], r["cutoff"]))
    if not completed:
        raise ValueError("No observations completed all LLM arms")
    keys = [(row["cik"], row["cutoff"]) for row in completed]
    test = baseline.loc[keys]
    y = test["positive"].to_numpy()
    scores = {arm: test[f"{arm}_score"].to_numpy() for arm in ("A0", "A1")}
    high = {arm: test[f"{arm}_high"].to_numpy() for arm in ("A0", "A1")}
    citations = {arm: {} for arm in ("B", "C", "D")}
    confusion = {f"E{e}_D{d}": 0 for e in (0, 1) for d in (0, 1)}
    followed_majority = lone_correct_overruled = 0

    for arm in ("B", "C", "E", "D"):
        answers = [row["result"]["arms"][arm] for row in completed]
        scores[arm] = [answer["p"] for answer in answers]
        high[arm] = [answer["label"] == "High" for answer in answers]

    for row, key, outcome, e, d in zip(completed, keys, y, high["E"], high["D"]):
        packet = packets[key]
        full = {**packet["numeric"], **packet["narrative"]}
        result = row["result"]
        confusion[f"E{int(e)}_D{int(d)}"] += 1
        roles = list(result["round_one"])
        initial = [result["round_one"][role]["p"] >= .5 for role in roles]
        revised = [result["round_two"][role]["p"] >= .5 for role in roles]
        if sum(initial) != 2:
            majority = sum(initial) > 2
            followed_majority += sum(a != majority and b == majority for a, b in zip(initial, revised))
        lone_correct_overruled += sum(pred == outcome for pred in initial) == 1 and d != outcome
        for arm in citations:
            evidence = result.get("tool_evidence", packet["numeric"] if arm == "B" else full)
            for claim in result["arms"][arm]["claims"]:
                verdict = check_claim(claim, evidence)
                citations[arm][verdict] = citations[arm].get(verdict, 0) + 1

    intervals, paired, skipped = cluster_auroc(y, test.index.get_level_values("cik"),
                                              scores, COMPARISONS)
    arms = {arm: score(y, rank, high[arm], rank if arm != "A0" else None)
            for arm, rank in scores.items()}
    sectors = pd.read_csv(root / "sample.csv").set_index("cik").loc[
        test.index.get_level_values("cik"), "sector"
    ]
    sector_scores = figures(y, scores, sectors, root / "figures")
    strict = pd.read_csv(root / "labels.csv").set_index(["cik", "cutoff"]).loc[keys, "e1"]
    strict_auroc = {
        arm: score(strict, rank, high[arm])["auroc"] for arm, rank in scores.items()
    } if strict.nunique() == 2 else None
    summary = {
        "sector_auroc": sector_scores, "e1_only_auroc": strict_auroc,
        "N_TEST_LLM": len(y), "test_event_rate": float(y.mean()),
        "arms": arms, "auroc_95_cluster_intervals": intervals, "bootstrap_skipped": skipped,
        "paired_deltas": {f"{a}-{b}": {"auroc_delta": arms[a]["auroc"] - arms[b]["auroc"],
                                      "interval": interval} for (a, b), interval in paired.items()},
        "E_vs_D_high": confusion, "F_CONF": int(followed_majority),
        "F_OVR": int(lone_correct_overruled), "citations": citations,
        "failed_observations": sum("error" in row for row in records),
    }
    (root / "arm_metrics.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()

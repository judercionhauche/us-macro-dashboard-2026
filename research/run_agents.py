"""Run a ten-observation pilot, then the full or prescribed reduced test cohort."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from datetime import date
import json
import os
from pathlib import Path
import time

from research.agents import run_arms
from research.llm import BudgetExceeded, CallFailed, Client


REDUCED = {"2023-06-30", "2023-12-31", "2024-06-30", "2024-12-31"}


def load_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def run(client, rows, out, *, analysis=None):
    done = {(r["cik"], r["cutoff"]): r for r in load_jsonl(out)} if out.exists() else {}
    def evaluate(row):
        key = row["cik"], row["cutoff"]
        if key in done:
            return done[key]
        try:
            if analysis is None:
                outcome = run_arms(client, row["numeric"], row["narrative"])
            else:
                from research.live_debate import grounded_research
                outcome = grounded_research(client, analysis(row))
            return {"cik": key[0], "cutoff": key[1], "result": outcome}
        except (CallFailed, BudgetExceeded) as exc:
            return {"cik": key[0], "cutoff": key[1], "error": str(exc)}

    with out.open("a", encoding="utf-8") as stream, ThreadPoolExecutor(max_workers=8) as pool:
        for record in pool.map(evaluate, rows):
            key = record["cik"], record["cutoff"]
            if key not in done:
                stream.write(json.dumps(record, allow_nan=False) + "\n")
                stream.flush()
                done[key] = record
    return [done[row["cik"], row["cutoff"]] for row in rows]


def research_tools(root):
    import pandas as pd
    from research.download import companyfacts
    from research.live_tools import AnalysisTools
    from research.packets import dollar_scale
    from research.panel import build_quarters

    panel = pd.read_csv(root / "panel.csv")
    sectors = pd.read_csv(root / "sample.csv").set_index("cik")["sector"]
    groups = {key: group.to_dict("list") for key, group in panel.groupby(["sector","cutoff"])}

    def tools_for(row):
        cik = int(row["cik"])
        cutoff = date.fromisoformat(row["cutoff"])
        filing = (date.fromisoformat(row["filing_date"]), tuple(row["narrative"].values()))
        return AnalysisTools(build_quarters(companyfacts(cik), cutoff), cutoff,
                             groups.get((sectors[cik], row["cutoff"]), {}), [filing], dollar_scale(cik))

    return tools_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--tool-grounded", action="store_true")
    parser.add_argument("--full-test-size", type=int, required=True)
    args = parser.parse_args()
    root = args.results
    digest = hashlib.sha256((root / "labels.csv").read_bytes()).hexdigest()
    if digest not in (root / "run_log.md").read_text(encoding="utf-8"):
        raise ValueError("Labels do not match the frozen SHA-256")
    rows = load_jsonl(root / "packets.jsonl")
    if args.pilot and len(rows) != 10:
        raise ValueError(f"Pilot needs 10 complete packets, found {len(rows)}")
    if not rows or any(row["filing_date"] > row["cutoff"] for row in rows):
        raise ValueError("The prepared packet cohort is empty or contains a late filing")
    client = Client(root / "llm_calls.jsonl", float(os.environ.get("RISK_BUDGET_USD", "40")))
    analysis = research_tools(root) if args.tool_grounded else None
    prefix = "grounded_" if args.tool_grounded else ""
    plan = root / (prefix + "pilot_summary.json")
    if args.pilot:
        started = time.monotonic()
        before = client.spent
        records = run(client, rows, root / (prefix + "pilot_predictions.jsonl"), analysis=analysis)
        records = [r for r in records if "result" in r]
        if len(records) != 10:
            raise ValueError(f"Only {len(records)} of 10 pilot observations completed")
        duration = time.monotonic() - started
        cost = client.spent - before
        ledger = load_jsonl(root / "llm_calls.jsonl")
        successes = [r for r in ledger if r["status"] == "success"]
        if not cost:
            cost = sum(r["cost_usd"] for r in successes)
            duration = max(duration, sum(r["latency_s"] for r in successes) / 8)
        projection = {"MODEL": client.model, "pilot_observations": len(records),
                      "cost_per_observation": cost / 10, "seconds_per_observation": duration / 10,
                      "projected_cost": cost * args.full_test_size / 10,
                      "projected_seconds": duration * args.full_test_size / 10}
        projection["full"] = projection["projected_cost"] <= client.cap and projection["projected_seconds"] <= 10800
        plan.write_text(json.dumps(projection, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(projection, indent=2))
    else:
        projection = json.loads(plan.read_text(encoding="utf-8"))
        if projection["MODEL"] != client.model:
            raise ValueError("The provider model differs from the pilot")
        if not projection["full"]:
            rows = [row for row in rows if row["cutoff"] in REDUCED]
        records = run(client, rows, root / (prefix + "llm_predictions.jsonl"), analysis=analysis)
        print(json.dumps({"N_TEST_LLM": sum("result" in r for r in records),
                          "failed_observations": sum("error" in r for r in records),
                          "MODEL": client.model, "estimated_spend_usd": client.spent}))


if __name__ == "__main__":
    main()

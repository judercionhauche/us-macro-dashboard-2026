"""Prepare matched test evidence from SEC statements and the sample sector medians."""
import argparse
from bisect import bisect_right
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
from pathlib import Path
from urllib.error import URLError

import pandas as pd

from research.download import companyfacts
from research.features import ratios
from research.filing_text import filing_packet
from research.packets import dollar_scale, numeric_packet
from research.panel import build_quarters


def company_packets(task):
    issuer, cohort, medians = task
    cik = int(issuer["cik"])
    payload = companyfacts(cik)
    identifiers = [issuer["ticker"], payload.get("entityName", "")]
    statements = issuer["statements"]
    dates = [f["filingDate"] for f in statements]
    result, failures = [], []
    for row in cohort:
        key = {"cik": cik, "cutoff": row["cutoff"]}
        cutoff = date.fromisoformat(row["cutoff"])
        i = bisect_right(dates, row["cutoff"]) - 1
        if i < 0:
            failures.append({**key, "reason": "no statement before cutoff"})
            continue
        try:
            narrative = filing_packet(cik, statements[i], cutoff, identifiers, dollar_scale(cik))
        except (ValueError, URLError) as exc:
            failures.append({**key, "reason": str(exc),
                             "accession": statements[i]["accessionNumber"]})
            continue
        quarters = build_quarters(payload, cutoff)
        numeric = numeric_packet(quarters, cutoff, cik, medians[row["cutoff"], row["sector"]])
        result.append({**key, "numeric": numeric, "narrative": narrative,
                       "filing_accession": statements[i]["accessionNumber"],
                       "filing_date": statements[i]["filingDate"]})
    return result, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--filings", type=Path, required=True)
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    root = args.results
    issuers = {int(r["cik"]): r for r in json.loads(args.filings.read_text())}
    panel = pd.read_csv(root / "panel.csv")
    labels = pd.read_csv(root / "labels.csv")
    test = labels[labels["split"] == "test"].merge(
        panel, on=["cik", "cutoff", "ticker"], validate="one_to_one"
    ).dropna(subset=["altman_z"]).sort_values(["cik", "cutoff"])
    if args.limit:
        test = test.sample(min(len(test), args.limit), random_state=244).sort_values(["cik", "cutoff"])
    feature_names = list(ratios([]))
    medians = panel.groupby(["cutoff", "sector"])[feature_names].median().to_dict("index")
    cohorts = defaultdict(list)
    for row in test[["cik", "cutoff", "sector"]].to_dict("records"):
        cohorts[row["cik"]].append(row)
    jobs = [(issuers[cik], cohort, medians) for cik, cohort in cohorts.items()]
    with ThreadPoolExecutor(max_workers=8) as pool:
        available = list(pool.map(company_packets, jobs))
    for name, index in (("packets.jsonl", 0), ("packet_failures.jsonl", 1)):
        with (root / name).open("w", encoding="utf-8") as stream:
            for group in available:
                for record in group[index]:
                    stream.write(json.dumps(record, allow_nan=False) + "\n")
    n = sum(len(group[0]) for group in available)
    print(f"Prepared {n}/{len(test)} packets")
    if n == 0:
        raise SystemExit("No complete evidence packets were available")


if __name__ == "__main__":
    main()

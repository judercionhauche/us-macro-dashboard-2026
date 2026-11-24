"""Collect issuer-level EDGAR events for the label audit and evidence lookup."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import json
from pathlib import Path
import re

from research.filings import document_url, filing_history


ITEM = re.compile(r"\b(?:1\.03|2\.01)\b")
EXIT_FORMS = {"15-12B", "15-12G", "15-15D", "25", "25-NSE"}


def collect(company):
    cik = int(company["cik"])
    filings = filing_history(cik)
    candidates = [
        {**filing, "url": document_url(cik, filing)}
        for filing in filings
        if filing["form"] in EXIT_FORMS or (
            filing["form"] in {"8-K", "8-K/A"} and ITEM.search(filing["items"])
        )
    ]
    statements = [filing for filing in filings if filing["form"] in {"10-K", "10-Q"}]
    return {**company, "event_candidates": candidates, "statements": statements}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", type=Path, default=Path("results/sample.csv"))
    parser.add_argument("--out", type=Path, default=Path("/tmp/m2-filing-audit.json"))
    args = parser.parse_args()
    with args.sample.open(newline="", encoding="utf-8") as stream:
        companies = list(csv.DictReader(stream))
    with ThreadPoolExecutor(max_workers=8) as pool:
        audited = list(pool.map(collect, companies))
    args.out.write_text(json.dumps(audited), encoding="utf-8")
    print(f"Reviewed filing indexes for {len(audited)} issuers")


if __name__ == "__main__":
    main()

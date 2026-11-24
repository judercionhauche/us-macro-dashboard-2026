"""Turn the reviewed EDGAR filing histories into an auditable event manifest."""
import argparse
import csv
import json
from pathlib import Path


REVIEWED_THROUGH = "2026-03-31"
# The report date on the multi-item 8-K precedes the closing of this combination.
CLOSING_DATES = {"1732845": "2024-07-05"}


def manifest_row(issuer):
    candidate = [f for f in issuer["event_candidates"] if f["filingDate"] <= REVIEWED_THROUGH]
    statements = [f for f in issuer["statements"] if f["filingDate"] <= REVIEWED_THROUGH]
    cik = issuer["cik"]
    source = f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"
    bankruptcy = [f for f in candidate if "1.03" in f["items"].split(",")]
    exits = [f for f in candidate if f["form"].startswith("15")
             and f["filingDate"] > "2018-12-31"]
    mergers = []
    if exits and statements and statements[-1]["filingDate"] < "2025-10-01":
        last_exit = exits[-1]["filingDate"]
        mergers = [f for f in candidate
                   if {"2.01", "5.01"} <= set(f["items"].split(","))
                   and "2018-12-31" < f["filingDate"] <= last_exit]
        if not mergers:
            raise ValueError(f"Review the reporting exit for {issuer['ticker']}")
    acquired = ""
    if mergers:
        final = mergers[-1]
        acquired = CLOSING_DATES.get(cik, final["reportDate"] or final["filingDate"])
        source += " " + final["url"]
    return {
        "cik": cik, "acquired": acquired,
        "bankruptcies": ";".join(sorted({f["reportDate"] or f["filingDate"] for f in bankruptcy})),
        "reviewed_through": REVIEWED_THROUGH,
        "source": " ".join([source, *(f["url"] for f in bankruptcy)]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audit", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    issuers = json.loads(args.audit.read_text(encoding="utf-8"))
    rows = [manifest_row(issuer) for issuer in issuers]
    with args.out.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"{sum(bool(r['acquired']) for r in rows)} acquisition exits, "
          f"{sum(bool(r['bankruptcies']) for r in rows)} issuers with bankruptcy filings")


if __name__ == "__main__":
    main()

"""Audit post-2024 financial facts and filing document coverage."""
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from research.download import CACHE, companyfacts, get
from research.filings import document_url, filing_history


def audit(row):
    cik = int(row["cik"])
    today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    facts = companyfacts(cik)
    filings = [f for f in filing_history(cik, date(2017,1,1))
               if f["form"] in {"10-K","10-Q"} and f["filingDate"] <= today]
    current = [f for f in filings if f["filingDate"] >= "2025-01-01"]
    readable = 0
    failures = 0
    for filing in current:
        if (CACHE / "demo-filings" / (filing["accessionNumber"] + ".json")).is_file():
            readable += 1
            continue
        try:
            body = get(document_url(cik,filing), timeout=8, retries=0)
            if body:
                readable += 1
        except (OSError, TimeoutError):
            failures += 1
    obs = facts["facts"].get("us-gaap", {}).get("Assets", {}).get("units", {}).get("USD", [])
    return {"ticker":row["ticker"],"cik":cik,
            "latest_filing":filings[-1]["filingDate"] if filings else "",
            "latest_assets_period":max((r["end"] for r in obs if r.get("filed","9999") <= today),default=""),
            "filings_2025_2026":len(current),"documents_available":readable,"documents_denied_or_failed":failures}


def main():
    companies = list(csv.DictReader(Path("results/sample.csv").open()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(audit, companies))
    with Path("results/current_filing_coverage.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(len(rows), sum(r["documents_available"] for r in rows),
          sum(r["documents_denied_or_failed"] for r in rows))


if __name__ == "__main__":
    main()

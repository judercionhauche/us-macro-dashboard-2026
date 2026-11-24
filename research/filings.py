"""Load historical EDGAR filing indexes, including archived submission pages."""
from datetime import date

from research.download import sec_json, submissions


def _rows(columns):
    fields = ("accessionNumber", "filingDate", "reportDate", "form", "items", "primaryDocument")
    length = len(columns["accessionNumber"])
    for i in range(length):
        yield {field: columns[field][i] if field in columns else "" for field in fields}


def filing_history(cik, since=date(2017, 1, 1)):
    data = submissions(cik)["filings"]
    rows = list(_rows(data["recent"]))
    for archive in data["files"]:
        if date.fromisoformat(archive["filingTo"]) >= since:
            rows.extend(_rows(sec_json("https://data.sec.gov/submissions/" + archive["name"])))
    unique = {row["accessionNumber"]: row for row in rows
              if date.fromisoformat(row["filingDate"]) >= since}
    return sorted(unique.values(), key=lambda row: (row["filingDate"], row["accessionNumber"]))


def document_url(cik, filing):
    accession = filing["accessionNumber"].replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession}/{filing['primaryDocument']}"

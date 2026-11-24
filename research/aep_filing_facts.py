"""Extract AEP consolidated financial rows from issuer 10-Q text."""
import argparse
from datetime import date
import json
from pathlib import Path
import re

from research.download import CACHE
from research.filings import filing_history


DIRECT = {
    "Revenues":"TOTAL REVENUES", "OperatingIncomeLoss":"OPERATING INCOME",
    "InterestExpense":"Interest Expense", "NetIncomeLoss":"EARNINGS ATTRIBUTABLE TO AEP COMMON SHAREHOLDERS",
    "Assets":"TOTAL ASSETS", "AssetsCurrent":"TOTAL CURRENT ASSETS",
    "Liabilities":"TOTAL LIABILITIES", "LiabilitiesCurrent":"TOTAL CURRENT LIABILITIES",
    "RetainedEarningsAccumulatedDeficit":"Retained Earnings", "StockholdersEquity":"TOTAL AEP COMMON SHAREHOLDERS’ EQUITY",
    "ShortTermBorrowings":"Total Short-term Debt",
}
FLOWS = {"Revenues", "OperatingIncomeLoss", "InterestExpense", "NetIncomeLoss"}
NUMBER = r"\(?[\d,]+\)?"


def millions(text, label):
    match = re.search(r"^" + re.escape(label) + r"[ \t]+\$?[ \t]*(" + NUMBER + r")(?=\s|$)",
                      text, re.M | re.I)
    if not match:
        raise ValueError(f"Missing consolidated row: {label}")
    return (-1 if match[1].startswith("(") else 1) * int(match[1].strip("()").replace(",", "")) * 1_000_000


def extract(text, filing):
    end = date.fromisoformat(filing["reportDate"])
    quarter = (end.month + 2) // 3
    qstart = date(end.year, (quarter-1)*3+1, 1)
    if f"{end.year} and {end.year-1}" not in text or "(in millions" not in text:
        raise ValueError("Report header or units missing")
    statements = text[text.index("\nCONDENSED CONSOLIDATED STATEMENTS OF INCOME\n"):]
    stop = statements.index("\nCONDENSED CONSOLIDATED STATEMENTS OF CASH FLOWS\n")
    income_and_balance = statements[:stop]
    flows = statements[stop:]
    result = []
    def add(tag, val, start=None):
        observation = {"tag":tag,"end":end.isoformat(),"filed":filing["filingDate"],
                       "accn":filing["accessionNumber"],"fp":f"Q{quarter}","form":"10-Q","val":val}
        if start:
            observation["start"] = start.isoformat()
        result.append(observation)
    for tag, name in DIRECT.items():
        try:
            value = millions(income_and_balance, name)
            add(tag, abs(value) if tag == "InterestExpense" else value,
                qstart if tag in FLOWS else None)
        except ValueError:
            if tag != "StockholdersEquity":
                raise
    assets = income_and_balance.split("\nCONDENSED CONSOLIDATED BALANCE SHEETS\n",1)[1]
    cash = re.search(r"^Cash and Cash Equivalents(?:\n[^\n]*\))?[ \t]+\$?[ \t]*(" +
                     NUMBER + r")(?=\s|$)", assets, re.M)
    if cash:
        add("CashAndCashEquivalentsAtCarryingValue", int(cash[1].replace(",", ""))*1_000_000)
    liabilities = income_and_balance[income_and_balance.index("\nCURRENT LIABILITIES\n"):]
    for tag, heading, ending in (("LongTermDebtCurrent","Long-term Debt Due Within One Year","Risk Management Liabilities"),
                                  ("LongTermDebtNoncurrent","Long-term Debt","Long-term Risk Management Liabilities")):
        block = liabilities.split("\n"+heading+"\n",1)[1].split("\n"+ending,1)[0]
        match = re.search(r"\)\s*(" + NUMBER + r")\s+" + NUMBER + r"\s*$", block.strip())
        if not match:
            raise ValueError(f"Missing amount for {tag}")
        add(tag, int(match[1].replace(",", ""))*1_000_000)
    add("NetCashProvidedByUsedInOperatingActivities",
        millions(flows, "Net Cash Flows from Operating Activities"), date(end.year,1,1))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+", help="Extracted report text as YYYY-MM-DD=/path")
    args = parser.parse_args()
    filings = {f["reportDate"]:f for f in filing_history(4904, date(2025,1,1)) if f["form"]=="10-Q"}
    rows = []
    for item in args.reports:
        end, path = item.split("=",1)
        rows.extend(extract(Path(path).read_text(), filings[end]))
    output = CACHE / "issuer-facts" / "4904.json"
    output.parent.mkdir(exist_ok=True, parents=True)
    output.write_text(json.dumps(rows))


if __name__ == "__main__":
    main()

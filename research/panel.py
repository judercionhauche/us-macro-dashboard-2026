"""Build point-in-time quarter measures from SEC company facts."""
from collections import defaultdict
from datetime import date, timedelta

from research.sec_facts import Measure, first_filed, quarter_flow, validate_cutoff


FLOW_TAGS = {
    "revenue": ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"),
    "ebit": ("OperatingIncomeLoss",),
    "interest": ("InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"),
    "net_income": ("NetIncomeLoss", "ProfitLoss"),
    "operating_cash_flow": ("NetCashProvidedByUsedInOperatingActivities",
                            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
    "dividends_per_share": ("CommonStockDividendsPerShareDeclared",),
    "dividends_paid": ("PaymentsOfDividendsCommonStock", "PaymentsOfDividends"),
}
STOCK_TAGS = {
    "assets": ("Assets",),
    "current_assets": ("AssetsCurrent",),
    "liabilities": ("Liabilities",),
    "current_liabilities": ("LiabilitiesCurrent",),
    "cash": ("CashAndCashEquivalentsAtCarryingValue",
             "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"),
    "retained": ("RetainedEarningsAccumulatedDeficit",),
    "equity": ("StockholdersEquity",),
}


def fiscal_quarters(companyfacts, cutoff):
    """Identify fiscal quarter ends from each filing's own fiscal period."""
    facts = first_filed(companyfacts, cutoff)
    ends_by_accession = defaultdict(list)
    source = companyfacts["facts"].get("us-gaap", {})
    for tag in ("Assets", "LiabilitiesAndStockholdersEquity"):
        for observation in source.get(tag, {}).get("units", {}).get("USD", []):
            if observation.get("form") not in {"10-K", "10-Q"}:
                continue
            if observation.get("fp") not in {"Q1", "Q2", "Q3", "FY"}:
                continue
            if date.fromisoformat(observation["filed"]) <= cutoff:
                ends_by_accession[observation["accn"]].append(observation)
    periods = {}
    for records in ends_by_accession.values():
        observation = max(records, key=lambda item: item["end"])
        end = date.fromisoformat(observation["end"])
        if end <= cutoff and end not in periods:
            periods[end] = observation["fp"]
    return facts, sorted(periods.items())


def build_quarters(companyfacts, cutoff):
    facts, periods = fiscal_quarters(companyfacts, cutoff)
    instants = {(f.tag, f.end): f for f in facts if f.start is None and f.unit == "USD"}
    flows_by_end = defaultdict(list)
    for fact in facts:
        if fact.start is not None:
            flows_by_end[fact.end].append(fact)
    quarter_rows = {}
    fiscal_start = previous_end = None

    for end, period in periods:
        quarter_start = previous_end + timedelta(days=1) if previous_end else None
        if period == "Q1":
            fiscal_start = quarter_start
            if fiscal_start is None:
                fiscal_start = max(
                    (f.start for f in facts if f.end == end and f.start
                     and 70 <= (end - f.start).days <= 110),
                    default=None,
                )
                quarter_start = fiscal_start

        row = {}
        for name, tags in STOCK_TAGS.items():
            fact = next((instants[tag, end] for tag in tags if (tag, end) in instants), None)
            row[name] = Measure(fact.value, (fact,)) if fact else None
        total = instants.get(("LiabilitiesAndStockholdersEquity", end))
        if row["liabilities"] is None and total and row["equity"]:
            row["liabilities"] = Measure(total.value - row["equity"].value,
                                         (total, *row["equity"].sources))
        debt_tags = ("LongTermDebtNoncurrent", "LongTermDebtCurrent", "ShortTermBorrowings")
        if not any((tag, end) in instants for tag in debt_tags[:2]):
            debt_tags = ("LongTermDebt", "DebtCurrent")
        row["debt"] = _sum_stock(
            Measure(instants[tag, end].value, (instants[tag, end],))
            for tag in debt_tags if (tag, end) in instants
        )
        if quarter_start is not None and 70 <= (end - quarter_start).days <= 110:
            nearby_facts = flows_by_end[end] + flows_by_end[previous_end]
            for name, tags in FLOW_TAGS.items():
                row[name] = quarter_flow(
                    nearby_facts, tags=tags, unit="USD/shares" if name == "dividends_per_share" else "USD",
                    fiscal_start=fiscal_start or quarter_start,
                    quarter_start=quarter_start, quarter_end=end, previous_end=previous_end,
                )
        for measure in row.values():
            if measure is not None:
                validate_cutoff(cutoff, measure.sources)
        quarter_rows[end] = row
        previous_end = end

    return quarter_rows


def _sum_stock(values):
    present = [value for value in values if value is not None]
    if present:
        return Measure(sum(value.value for value in present),
                       tuple(fact for value in present for fact in value.sources))
    return None

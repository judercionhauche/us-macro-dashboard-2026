"""Build numeric evidence packets without exposing issuer keys or calendar dates."""
from datetime import date
import hashlib
import math
import random

from research.features import ratios
from research.sec_facts import trailing_four, validate_cutoff


DOLLARS = {
    "revenue", "ebit", "interest", "net_income", "operating_cash_flow",
    "dividends", "assets", "current_assets",
    "liabilities", "current_liabilities", "cash", "retained", "equity", "debt",
}


def dollar_scale(cik):
    return random.Random(hashlib.sha256(f"244:{cik}".encode()).digest()).uniform(0.5, 2)


def format_value(value):
    return format(value, "#.3g").rstrip(".") if math.isfinite(value) else "not reported"


def format_money(value, per_share=False):
    if per_share:
        return f"{format_value(value)} USD per share"
    for divisor, unit in ((1e12, "trillion"), (1e9, "billion"), (1e6, "million"), (1e3, "thousand")):
        if abs(value) >= divisor:
            return f"{format_value(value / divisor)} {unit} USD"
    return f"{format_value(value)} USD"


def numeric_packet(quarters, cutoff: date, cik, sector_medians, *, mode="research"):
    """Return only model-visible facts. Provenance stays on the research side."""
    if mode not in {"research", "demo"}:
        raise ValueError("Invalid packet mode")
    history = [quarters[end] for end in sorted(quarters)]
    factor = dollar_scale(cik) if mode == "research" else 1.0
    facts = {}
    def add(text):
        facts[f"F{len(facts) + 1}"] = text

    for lag in range(7, -1, -1):
        row = history[-lag - 1] if len(history) > lag else {}
        for field in sorted(DOLLARS):
            unit = ""
            measure = row.get(field)
            if field == "dividends":
                measure = row.get("dividends_per_share")
                if measure is not None:
                    unit = " per share"
                else:
                    measure = row.get("dividends_paid")
                    unit = " paid"
            if measure is None:
                value = "not reported"
            else:
                validate_cutoff(cutoff, measure.sources)
                value = format_money(measure.value * factor, per_share=unit == " per share")
            add(f"Q{-lag}: {field.replace('_', ' ')}{unit} = {value}")
    for field in ("revenue", "ebit", "interest", "net_income", "operating_cash_flow"):
        measure = trailing_four(row.get(field) for row in history[-4:])
        if measure:
            validate_cutoff(cutoff, measure.sources)
        value = format_money(measure.value * factor) if measure else "not reported"
        add(f"Last four quarters added up: {field.replace('_', ' ')} = {value}")
    for field, value in ratios(history).items():
        if field == "log_assets":
            value += math.log(factor)
        rendered = format_value(value)
        add(f"Company {field.replace('_', ' ')} = {rendered}")
    for field, value in sorted(sector_medians.items()):
        if field != "log_assets" and math.isfinite(value):
            add(f"Sector median {field.replace('_', ' ')} = {format_value(value)}")
    return facts

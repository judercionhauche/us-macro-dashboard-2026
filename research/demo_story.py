"""Presentation-only narration, filing lookup and transcript formatting."""
from datetime import date
import json

import pandas as pd

from research.download import CACHE
from research.filing_text import filing_packet, redact
from research.filings import filing_history
from research.packets import dollar_scale


PRESENTER = (
    "Write only the spoken wording for this moment in a live college-class debate. "
    "Sound like a warm, confident human host. Short sentences, everyday words, a clear "
    "point. No jargon, stage directions, cliches, or invented facts. Put your complete "
    "line in say. The risk and claims fields are unused for this host-only turn."
)


def present(call, title, instruction, context, slots=None):
    slots = slots or {}
    if slots:
        instruction += " Include each listed placeholder exactly once, unchanged."
    response = call("presentation", "host", 0, f"{PRESENTER} {instruction}",
                    {"segment": title, **context, "placeholders": list(slots)})
    spoken = response["say"].strip()
    for token, value in slots.items():
        if spoken.count(token) != 1:
            raise ValueError(f"The generated {title.lower()} did not preserve {token}.")
        spoken = spoken.replace(token, value)
    return spoken


def narrative_evidence(cik, ticker, name, cutoff, mode):
    filings = [item for item in filing_history(cik, since=date(cutoff.year - 1, 1, 1))
               if item["form"] in {"10-K", "10-Q"} and item["filingDate"] <= cutoff.isoformat()]
    if not filings:
        raise ValueError("Filing Narrative unavailable: no eligible 10-K or 10-Q in the filing history.")
    filing = filings[-1]
    scale = dollar_scale(cik) if mode == "research" else 1
    identifiers = [ticker, name, "American Electric Power Company", "American Electric Power"]
    mirror = CACHE / "demo-filings" / (filing["accessionNumber"] + ".json")
    if mirror.exists():
        source = json.loads(mirror.read_text())
        if source["accession"] != filing["accessionNumber"] or source["filed"] != filing["filingDate"]:
            raise ValueError("Filing mirror does not match the latest eligible SEC filing.")
        excerpts = {f"T{i}": redact(paragraph, identifiers, scale)
                    for i, paragraph in enumerate(source["paragraphs"], 1)}
        return excerpts, source["url"]
    try:
        return filing_packet(cik, filing, cutoff, identifiers, scale), None
    except (OSError, ValueError) as exc:
        raise ValueError(f"Filing Narrative unavailable for {filing['accessionNumber']}: {exc}") from exc


def outcome_facts(labels, cik, cutoff):
    labels = pd.read_csv(labels)
    observed = labels[(labels["cik"] == cik) & (labels["cutoff"] == cutoff.isoformat())]
    if observed.empty:
        return {"verified": False}
    row = observed.iloc[0]
    return {
        "verified": True,
        "events": [description for field, description in (
            ("e1", "reported a full-year loss"),
            ("e2", "cash from day-to-day business fell by more than half"),
            ("e3", "cut its regular payout to shareholders"),
            ("bankruptcy", "filed for bankruptcy"),
        ) if row[field]],
    }

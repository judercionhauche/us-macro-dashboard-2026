"""Extract bounded MD&A and risk-factor excerpts from downloaded filing HTML."""
from datetime import date
import os
from pathlib import Path
import re

from bs4 import BeautifulSoup

from research.download import get
from research.filings import document_url


HEADINGS = re.compile(r"^item\s+(\d+[a-z]?)\s*[.:–—-]?\s*(.*)$", re.I)
TOPICS = re.compile(r"liquidity|outlook|demand|cash flow|debt|profit|margin|risk", re.I)
CALENDAR_DATE = re.compile(
    r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"(?:\s+\d{1,2},)?\s+(?:19|20)\d{2}\b", re.I,
)
YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
MONEY = re.compile(r"(?P<prefix>\$\s*|USD\s*)(?P<value>\d[\d,]*(?:\.\d+)?)", re.I)


def sections(html, form):
    soup = BeautifulSoup(html, "html.parser")
    for unwanted in soup.find_all(["script", "style", "table", "ix:header"]):
        unwanted.decompose()
    mda = "7" if form == "10-K" else "2"
    collected = {"mda": [], "risk": []}
    active = None
    for block in soup.find_all(["div", "p", "h1", "h2", "h3", "h4", "li"]):
        if block.find(["p", "div", "li", "h1", "h2", "h3", "h4"]):
            continue
        text = " ".join(block.stripped_strings)
        match = HEADINGS.fullmatch(text) if len(text) < 250 else None
        if match:
            item, title = match.groups()
            title = title.casefold()
            active = ("mda" if item == mda and "management" in title else
                      "risk" if item.lower() == "1a" and "risk" in title else None)
        elif active and len(text.split()) >= 18:
            collected[active].append(text)
    return collected


def redact(text, identifiers, scale):
    for identifier in sorted({s for s in identifiers if s}, key=len, reverse=True):
        text = re.sub(r"(?<!\w)" + re.escape(identifier) + r"(?!\w)",
                      "the Company", text, flags=re.I)
    text = CALENDAR_DATE.sub("a reported period", text)
    text = YEAR.sub("[year]", text)
    text = MONEY.sub(lambda m: f"${float(m['value'].replace(',', '')) * scale:#.3g}", text)
    # Redact acronyms and multiword proper names in narrative text.
    text = re.sub(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b", "the Company", text)
    text = re.sub(r"\b[A-Z]{2,}\b", "the Company", text)
    return text


def filing_packet(cik, filing, cutoff, identifiers, scale, max_words=1200):
    if date.fromisoformat(filing["filingDate"]) > cutoff:
        raise ValueError("Filing text was unavailable at the cutoff")
    directory = os.environ.get("RISK_FILING_DIR")
    local = Path(directory) / (filing["accessionNumber"] + ".html") if directory else None
    html = local.read_bytes() if local is not None and local.is_file() else get(document_url(cik, filing))
    parsed = sections(html, filing["form"])
    mda = [p for p in parsed["mda"] if TOPICS.search(p)]
    risk = parsed["risk"]
    if not mda and not risk:
        raise ValueError("No usable MD&A or risk-factor paragraphs extracted")
    result = {}
    remaining = max_words
    # Keep early risk factors alongside MD&A in the bounded excerpt.
    for paragraphs, budget in ((mda, max_words * 2 // 3), (risk, max_words)):
        limit = min(remaining, budget)
        for paragraph in paragraphs:
            words = redact(paragraph, identifiers, scale).split()[:limit]
            if not words:
                break
            result[f"T{len(result) + 1}"] = " ".join(words)
            limit -= len(words)
            remaining -= len(words)
    return result

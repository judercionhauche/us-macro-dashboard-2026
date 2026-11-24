"""Load first-filed SEC facts with provenance for point-in-time research."""
from dataclasses import dataclass
from datetime import date
from typing import Iterable


@dataclass(frozen=True)
class Fact:
    tag: str
    unit: str
    start: date | None
    end: date
    filed: date
    accession: str
    value: float


STATEMENT_FORMS = frozenset({"10-K", "10-Q", "10-K/A", "10-Q/A"})


def first_filed(companyfacts: dict, cutoff: date) -> list[Fact]:
    """Select the earliest filing per tag, unit and reporting period."""
    selected = {}
    for tag, series in companyfacts["facts"].get("us-gaap", {}).items():
        for unit, observations in series["units"].items():
            for observation in observations:
                if observation.get("form") not in STATEMENT_FORMS:
                    continue
                if not all(k in observation for k in ("end", "filed", "accn", "val")):
                    continue
                start = date.fromisoformat(observation["start"]) if "start" in observation else None
                end = date.fromisoformat(observation["end"])
                filed = date.fromisoformat(observation["filed"])
                if filed > cutoff or end > cutoff:
                    continue
                fact = Fact(tag, unit, start, end, filed, observation["accn"], observation["val"])
                key = (tag, unit, start, end)
                previous = selected.get(key)
                if previous is None or (filed, fact.accession) < (previous.filed, previous.accession):
                    selected[key] = fact
    return list(selected.values())


def validate_cutoff(cutoff: date, sources: Iterable[Fact]) -> None:
    """Reject late provenance, including dependencies of derived values."""
    for fact in sources:
        if fact.filed > cutoff or fact.end > cutoff:
            raise ValueError(
                f"{fact.tag} ({fact.accession}) exceeds {cutoff}: "
                f"period end {fact.end}, filed {fact.filed}"
            )


@dataclass(frozen=True)
class Measure:
    value: float
    sources: tuple[Fact, ...]


def quarter_flow(
    facts: Iterable[Fact],
    *,
    tags: tuple[str, ...],
    unit: str,
    fiscal_start: date,
    quarter_start: date,
    quarter_end: date,
    previous_end: date | None,
) -> Measure | None:
    """Use a discrete quarter if present, otherwise subtract the previous YTD."""
    by_period = {
        (fact.tag, fact.start, fact.end): fact
        for fact in facts if fact.unit == unit
    }
    for tag in tags:
        direct = by_period.get((tag, quarter_start, quarter_end))
        if direct is not None:
            return Measure(direct.value, (direct,))
        current = by_period.get((tag, fiscal_start, quarter_end))
        previous = by_period.get((tag, fiscal_start, previous_end))
        if current is not None and previous is not None:
            return Measure(current.value - previous.value, (current, previous))
    return None


def trailing_four(quarters: Iterable[Measure | None]) -> Measure | None:
    values = tuple(quarters)
    if len(values) != 4 or any(value is None for value in values):
        return None
    return Measure(
        sum(value.value for value in values),
        tuple(fact for value in values for fact in value.sources),
    )

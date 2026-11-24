"""Milestone 2 distress labels from first-filed fiscal-quarter TTM measures."""
from dataclasses import dataclass
from datetime import date
from typing import Iterable


@dataclass(frozen=True)
class Quarter:
    end: date
    net_income: float | None
    operating_cash_flow: float | None
    dividends_per_share: float | None
    dividends_paid: float | None


@dataclass(frozen=True)
class Outcome:
    loss_onset: bool
    cash_flow_collapse: bool
    dividend_cut: bool
    bankruptcy: bool

    @property
    def positive(self) -> bool:
        return any((self.loss_onset, self.cash_flow_collapse,
                    self.dividend_cut, self.bankruptcy))


def classify(
    cutoff: date,
    baseline: Quarter,
    future_quarters: Iterable[Quarter],
    *,
    acquired: date | None = None,
    bankruptcies: Iterable[date] = (),
) -> Outcome | None:
    """Return the observed event flags, or None when follow-up is incomplete."""
    if baseline.end > cutoff:
        raise ValueError("Baseline quarter ends after the cutoff")
    if acquired is not None and acquired <= cutoff:
        return None

    quarters = sorted(
        (q for q in future_quarters if q.end > cutoff and
         (acquired is None or q.end < acquired)),
        key=lambda q: q.end,
    )[:4]
    if len({q.end for q in quarters}) != len(quarters):
        raise ValueError("Duplicate fiscal quarter in label input")

    horizon = date(cutoff.year + 1, cutoff.month, 28 if
                   (cutoff.month, cutoff.day) == (2, 29) else cutoff.day)
    bankruptcy = any(
        cutoff < filed <= horizon and (acquired is None or filed < acquired)
        for filed in bankruptcies
    )
    loss = baseline.net_income is not None and baseline.net_income > 0 and any(
        q.net_income is not None and q.net_income < 0 for q in quarters
    )
    cash_flow = (
        baseline.operating_cash_flow is not None and baseline.operating_cash_flow > 0
        and any(q.operating_cash_flow is not None
                and q.operating_cash_flow < baseline.operating_cash_flow / 2
                for q in quarters)
    )
    dividend = False
    for q in quarters:
        before, after = baseline.dividends_per_share, q.dividends_per_share
        if before is None or after is None:
            before, after = baseline.dividends_paid, q.dividends_paid
        if before is not None and after is not None and before > 0 and after <= before * .75:
            dividend = True
            break

    outcome = Outcome(loss, cash_flow, dividend, bankruptcy)
    return outcome if len(quarters) == 4 or outcome.positive else None

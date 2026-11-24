"""Freeze audited company-quarter labels before fitting any model."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import csv
from datetime import date
import hashlib
import math
from pathlib import Path

from research.download import companyfacts
from research.features import trailing
from research.labels import Quarter, classify
from research.panel import build_quarters


def measure_quarters(quarters):
    history = list(quarters.values())
    def value(field, lag):
        result = trailing(history, field, lag)
        return result if math.isfinite(result) else None
    return [
        Quarter(end, value("net_income", lag), value("operating_cash_flow", lag),
                value("dividends_per_share", lag), value("dividends_paid", lag))
        for end, lag in zip(quarters, range(len(history) - 1, -1, -1))
    ]


def label_company(item):
    rows, events = item
    payload = companyfacts(int(rows[0]["cik"]))
    future = measure_quarters(build_quarters(payload, date.fromisoformat(events["reviewed_through"])))
    acquired = date.fromisoformat(events["acquired"]) if events["acquired"] else None
    bankruptcies = [date.fromisoformat(d) for d in events["bankruptcies"].split(";") if d]
    output = []
    for row in rows:
        cutoff = date.fromisoformat(row["cutoff"])
        baseline = measure_quarters(build_quarters(payload, cutoff))[-1]
        outcome = classify(cutoff, baseline, future, acquired=acquired, bankruptcies=bankruptcies)
        if outcome is not None:
            output.append({
                "ticker": row["ticker"], "cik": row["cik"], "cutoff": row["cutoff"],
                "split": "train" if cutoff.year <= 2021 else "val" if cutoff.year == 2022 else "test",
                "positive": int(outcome.positive), "e1": int(outcome.loss_onset),
                "e2": int(outcome.cash_flow_collapse), "e3": int(outcome.dividend_cut),
                "bankruptcy": int(outcome.bankruptcy),
            })
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", type=Path, default=Path("results/panel.csv"))
    parser.add_argument("--events", type=Path, required=True,
                        help="Audited CSV: cik, acquired, bankruptcies, reviewed_through, source")
    parser.add_argument("--out", type=Path, default=Path("results/labels.csv"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    log = args.out.parent / "run_log.md"
    if args.out.exists():
        raise FileExistsError(f"Labels already frozen at {args.out}")
    with args.panel.open(newline="", encoding="utf-8") as stream:
        companies = {}
        for row in csv.DictReader(stream):
            companies.setdefault(row["cik"], []).append(row)
    with args.events.open(newline="", encoding="utf-8") as stream:
        events = {row["cik"]: row for row in csv.DictReader(stream)
                  if row["source"] and row["reviewed_through"] >= "2026-03-31"}
    missing = sorted(companies.keys() - events.keys())
    if missing:
        raise ValueError(f"Missing corporate-event audit for CIKs: {', '.join(missing)}")
    work = [(rows, events[cik]) for cik, rows in companies.items()]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        rows = [row for company in pool.map(label_company, work) for row in company]
    if not rows:
        raise ValueError("No eligible labels")
    args.out.parent.mkdir(exist_ok=True, parents=True)
    with args.out.open("x", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    digest = hashlib.sha256(args.out.read_bytes()).hexdigest()
    with log.open("a", encoding="utf-8") as stream:
        stream.write(f"\n- Frozen labels at `{args.out.name}`, {len(rows)} observations, SHA-256 `{digest}`.\n")
    print(digest)


if __name__ == "__main__":
    main()

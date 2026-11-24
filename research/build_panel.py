"""Generate cutoff-aligned features from the cached SEC sample."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import csv
from datetime import date
import math
from pathlib import Path

from research.download import companyfacts
from research.features import instant, ratios, trailing
from research.panel import build_quarters


CUTOFFS = tuple(
    date(year, month, day)
    for year in range(2018, 2025)
    for month, day in ((3, 31), (6, 30), (9, 30), (12, 31))
    if year > 2018 or month == 12
)


def build_company(row):
    payload = companyfacts(int(row["cik"]))
    panel = []
    for cutoff in CUTOFFS:
        quarters = build_quarters(payload, cutoff)
        if not quarters:
            continue
        rows = list(quarters.values())
        assets = instant(rows, "assets")
        income = trailing(rows, "net_income")
        ocf = trailing(rows, "operating_cash_flow")
        if not all(map(math.isfinite, (assets, income, ocf))):
            continue
        panel.append({
            **row, "cutoff": cutoff.isoformat(), "quarter_end": max(quarters).isoformat(),
            "assets": assets, "ttm_net_income": income, "ttm_operating_cash_flow": ocf,
            **ratios(rows),
        })
    return panel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", type=Path, default=Path("results/sample.csv"))
    parser.add_argument("--out", type=Path, default=Path("results/panel.csv"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    with args.sample.open(newline="", encoding="utf-8") as stream:
        companies = list(csv.DictReader(stream))
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        rows = [row for company in pool.map(build_company, companies) for row in company]
    if not rows:
        raise RuntimeError("No valid company-quarter observations")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    planned = len(companies) * len(CUTOFFS)
    print(f"Retained {len(rows)}/{planned} observations ({(1-len(rows)/planned):.1%} missing)")


if __name__ == "__main__":
    main()

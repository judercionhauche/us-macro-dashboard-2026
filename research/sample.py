"""Construct the study frame and proportional sector-stratified draw."""
import csv
from collections import Counter
from pathlib import Path

import numpy as np


def ticker_key(ticker):
    return ticker.strip().upper().replace(".", "-")


def membership_history(path):
    with Path(path).open(newline="", encoding="utf-8-sig") as stream:
        history = [
            (row["date"], {ticker_key(t) for t in row["tickers"].split(",") if t.strip()})
            for row in csv.DictReader(stream)
        ]
    return sorted(history, key=lambda row: row[0])


def members_at(history, cutoff):
    return next(tickers for date, tickers in reversed(history) if date <= cutoff)


def build_frame(history, metadata):
    """Metadata must resolve every historical ticker, including delisted firms."""
    initial = members_at(history, "2018-12-31")
    previous = initial
    departed = set()
    for date, tickers in history:
        if "2018-12-31" < date <= "2024-12-31":
            departed.update(previous - tickers)
            previous = tickers

    missing = sorted(ticker for ticker in initial if ticker not in metadata)
    if missing:
        raise ValueError(f"Unresolved historical ticker metadata ({len(missing)}): {', '.join(missing)}")
    companies = {}
    for ticker in sorted(initial):
        info = metadata[ticker]
        cik = int(info["cik"])
        if info["sector"] in {"Financials", "Real Estate"}:
            continue
        row = companies.setdefault(cik, dict(info, ticker=ticker, left_index=True))
        row["left_index"] &= ticker in departed
    return list(companies.values())


def stratified_sample(frame, count=100, seed=244):
    if not 0 < count <= len(frame):
        raise ValueError("Sample count must be positive and no larger than the frame")
    totals = Counter(row["sector"] for row in frame)
    allocation = {sector: n * count // len(frame) for sector, n in totals.items()}
    priority = sorted(totals, key=lambda s: (-(totals[s] * count % len(frame)), s))
    for sector in priority[:count - sum(allocation.values())]:
        allocation[sector] += 1

    random = np.random.RandomState(seed)
    sample = []
    for sector, n in sorted(allocation.items()):
        group = sorted((r for r in frame if r["sector"] == sector), key=lambda r: r["ticker"])
        sample.extend(group[i] for i in random.choice(len(group), n, replace=False))
    return sample


def read_metadata(paths):
    """Read archived and current constituent metadata in priority order."""
    metadata = {}
    for path in paths:
        with Path(path).open(newline="", encoding="utf-8-sig") as stream:
            for row in csv.DictReader(stream):
                ticker = ticker_key(row.get("Symbol") or row["ticker"])
                sector = row.get("GICS Sector") or row.get("sector")
                cik = row.get("CIK") or row.get("cik")
                if cik and sector:
                    metadata.setdefault(ticker, {
                        "cik": int(cik),
                        "sector": sector,
                        "sector_source": row.get("sector_source") or Path(path).name,
                    })
    return metadata


def main():
    import argparse
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--membership", required=True)
    parser.add_argument("--metadata", nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    history = membership_history(args.membership)
    metadata = read_metadata(args.metadata)
    frame = build_frame(history, metadata)
    sample = stratified_sample(frame)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=[
            "ticker", "cik", "sector", "sector_source", "left_index",
        ])
        writer.writeheader()
        writer.writerows(sample)
    print(json.dumps({
        "N_FRAME": len(frame), "N_SAMPLE": len(sample),
        "N_LEFT": sum(row["left_index"] for row in sample),
    }))


if __name__ == "__main__":
    main()

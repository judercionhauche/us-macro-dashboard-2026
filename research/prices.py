"""Use adjusted prices only to check the frozen distress labels."""
import argparse
import csv
import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import quote

import pandas as pd
from scipy.stats import mannwhitneyu

from research.download import CACHE, get


def read_url(url, cached_only):
    if not cached_only:
        return get(url, timeout=8, retries=0)
    entry = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if not entry.is_file():
        raise OSError("No cached response from source")
    return entry.read_bytes()


def prices(ticker, cached_only=False, yahoo_only=False):
    # Stooq's CSV endpoint sometimes returns an HTML browser challenge.
    stooq = f"https://stooq.com/q/d/l/?s={quote(ticker.lower())}.us&i=d"
    if not yahoo_only:
        try:
            body = read_url(stooq, cached_only).decode()
            rows = list(csv.DictReader(body.splitlines()))
            if rows and {"Date", "Close"} <= rows[0].keys():
                return pd.Series({pd.Timestamp(r["Date"]): float(r["Close"]) for r in rows}), "Stooq"
        except (OSError, UnicodeError, ValueError):
            pass
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(ticker)}"
           "?period1=1545955200&period2=1767312000&interval=1d")
    payload = json.loads(read_url(url, cached_only))["chart"]["result"][0]
    amounts = payload["indicators"]["adjclose"][0]["adjclose"]
    values = {pd.Timestamp(datetime.fromtimestamp(t, timezone.utc).date()): value
              for t, value in zip(payload["timestamp"], amounts) if value is not None}
    return pd.Series(values), "Yahoo Finance adjusted close"


def window_stats(series, cutoff):
    end = cutoff + pd.DateOffset(years=1)
    series = series.sort_index().dropna()
    before = series.loc[:cutoff]
    after = series.loc[cutoff:end]
    if before.empty or after.empty or (cutoff - before.index[-1]).days > 7:
        return None
    if (end - after.index[-1]).days > 7:
        return None
    path = pd.concat([before.iloc[-1:], after[after.index > cutoff]])
    return path.iloc[-1] / path.iloc[0] - 1, (path / path.cummax() - 1).min()


def load_prices(ticker, cached_only=False, yahoo_only=False):
    try:
        data, source = prices(ticker, cached_only, yahoo_only)
        return ticker, data, source, None
    except (OSError, ValueError, KeyError, IndexError, TypeError) as err:
        return ticker, None, None, str(err)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--yahoo-only", action="store_true")
    args = parser.parse_args()
    root = args.results
    labels = pd.read_csv(root / "labels.csv", parse_dates=["cutoff"])
    with ThreadPoolExecutor(max_workers=8) as pool:
        loaded = {ticker: (data, source, error)
                  for ticker, data, source, error in pool.map(
                      lambda t: load_prices(t, args.cached_only, args.yahoo_only), labels["ticker"].unique())}
    rows = []
    for item in labels.itertuples():
        data, source, _ = loaded[item.ticker]
        stats = None if data is None else window_stats(data, item.cutoff)
        if stats is not None:
            rows.append({
                "cik": item.cik, "cutoff": item.cutoff.date(), "positive": item.positive,
                "total_return": stats[0], "max_drawdown": stats[1], "source": source,
            })
    matched = pd.DataFrame(rows)
    if matched.empty or matched["positive"].nunique() != 2:
        raise ValueError("Insufficient adjusted-price coverage for the sanity check")
    matched.to_csv(root / "label_price_check.csv", index=False)
    summary = {"matched": len(matched), "eligible": len(labels), "cached_only": args.cached_only, "yahoo_only": args.yahoo_only,
               "coverage_by_source": matched["source"].value_counts().to_dict(),
               "issuer_failures": {ticker: error for ticker, (_, _, error) in loaded.items() if error}}
    for feature in ("total_return", "max_drawdown"):
        neg = matched.loc[matched["positive"] == 0, feature]
        pos = matched.loc[matched["positive"] == 1, feature]
        summary[feature] = {"positive_median": pos.median(), "negative_median": neg.median(),
                            "p": mannwhitneyu(pos, neg).pvalue}
    (root / "price_check_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Price check covered {len(matched)}/{len(labels)} observations")


if __name__ == "__main__":
    main()

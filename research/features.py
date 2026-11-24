"""Ratio and trend features defined in Milestone 2 Appendix A."""
import math

from research.baselines import altman_z
from research.sec_facts import trailing_four


def trailing(rows, field, lag=0):
    end = len(rows) - lag
    item = trailing_four(row.get(field) for row in rows[max(0, end - 4):end])
    return item.value if item else math.nan


def instant(rows, field, lag=0):
    if len(rows) <= lag:
        return math.nan
    item = rows[-1 - lag].get(field)
    return item.value if item else math.nan


def ratio(numerator, denominator):
    return numerator / denominator if denominator and math.isfinite(denominator) else math.nan


def ratios(rows):
    assets, liabilities = instant(rows, "assets"), instant(rows, "liabilities")
    current_assets = instant(rows, "current_assets")
    current_liabilities = instant(rows, "current_liabilities")
    cash, debt = instant(rows, "cash"), instant(rows, "debt")
    revenue, income = trailing(rows, "revenue"), trailing(rows, "net_income")
    ebit, interest = trailing(rows, "ebit"), trailing(rows, "interest")
    ocf = trailing(rows, "operating_cash_flow")
    dividends = trailing(rows, "dividends_per_share")
    if math.isnan(dividends):
        dividends = trailing(rows, "dividends_paid")
    coverage = ratio(ebit, interest)
    margin, leverage = ratio(income, revenue), ratio(debt, assets)

    return {
        "current_ratio": ratio(current_assets, current_liabilities),
        "cash_current_liabilities": ratio(cash, current_liabilities),
        "debt_assets": leverage,
        "interest_coverage": max(-50, min(50, coverage)) if math.isfinite(coverage) else coverage,
        "net_margin": margin,
        "roa": ratio(income, assets),
        "ocf_debt": ratio(ocf, debt),
        "ocf_margin": ratio(ocf, revenue),
        "revenue_growth_yoy": ratio(revenue, trailing(rows, "revenue", 4)) - 1,
        "net_margin_change_yoy": margin - ratio(trailing(rows, "net_income", 4),
                                              trailing(rows, "revenue", 4)),
        "debt_assets_change_yoy": leverage - ratio(instant(rows, "debt", 4),
                                                  instant(rows, "assets", 4)),
        "altman_z": altman_z(assets, current_assets, current_liabilities,
                             instant(rows, "retained"), ebit, instant(rows, "equity"),
                             liabilities),
        "log_assets": math.log(assets) if assets > 0 else math.nan,
        "loss_flag": int(income < 0) if math.isfinite(income) else math.nan,
        "dividend_payer_flag": int(dividends > 0) if math.isfinite(dividends) else math.nan,
    }

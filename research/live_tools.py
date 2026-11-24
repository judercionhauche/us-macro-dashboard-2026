"""Cutoff-checked tools for the live, tool-grounded debate."""
from datetime import date
from functools import lru_cache
import hashlib
import json
import math
import os
import subprocess
from pathlib import Path
import re
from time import monotonic

import numpy as np

from research.download import CACHE
from research.features import instant, ratios
from research.packets import format_money, format_value
from research.sec_facts import validate_cutoff

MONEY = {"revenue", "net_income", "operating_cash_flow", "debt", "cash", "assets"}
FEATURES = {
    "net_margin": "share of sales left as profit",
    "ocf_margin": "cash from day-to-day operations as a share of sales",
    "current_ratio": "short-term assets for each dollar of bills due soon",
    "cash_current_liabilities": "cash for each dollar of bills due soon",
    "debt_assets": "debt as a share of assets",
    "interest_coverage": "operating profit for each dollar of interest",
    "altman_z": "financial distress score; lower means more concern",
}
DESCRIPTION = {
    "get_metric": "metric and quarters_back (0 means latest): one company value",
    "compare_to_peers": "metric: company, same-cutoff median and rank (highest value ranks first)",
    "get_trend": "metric: change versus four and eight reported quarters earlier",
    "distress_score": "Altman Z double-prime and risk zone",
    "search_filing": "question: three relevant excerpts from the latest eligible filing",
    "filing_tone": "FinBERT sentence tone and comparison with a year before",
    "forecast": "revenue or operating_cash_flow: Lag-Llama forecasts for four quarters",
}


@lru_cache(maxsize=1)
def embedding_model():
    import torch
    from transformers import AutoModel, AutoTokenizer
    torch.set_num_threads(1)
    model = "sentence-transformers/all-MiniLM-L6-v2"
    return (AutoTokenizer.from_pretrained(model, local_files_only=True),
            AutoModel.from_pretrained(model, local_files_only=True).eval())


@lru_cache(maxsize=64)
def index_passages(passages):
    import torch
    tokenizer, model = embedding_model()
    inputs = tokenizer(list(passages), padding=True, truncation=True, max_length=256,
                       return_tensors="pt")
    with torch.inference_mode():
        output = model(**inputs).last_hidden_state
        mask = inputs["attention_mask"].unsqueeze(-1)
        pooled = (output * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
        return torch.nn.functional.normalize(pooled).numpy()


@lru_cache(maxsize=1)
def tone_model():
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline
    model = "ProsusAI/finbert"
    return pipeline("text-classification",
                    model=AutoModelForSequenceClassification.from_pretrained(model, local_files_only=True),
                    tokenizer=AutoTokenizer.from_pretrained(model, local_files_only=True), device=-1)


@lru_cache(maxsize=64)
def tone(passages):
    folder = CACHE / "finbert-tone"
    folder.mkdir(exist_ok=True, parents=True)
    key = hashlib.sha256(json.dumps(["ProsusAI/finbert", passages]).encode()).hexdigest()
    path = folder / (key + ".json")
    if path.is_file():
        return json.loads(path.read_text())
    sentences = [s.strip() for passage in passages
                 for s in re.split(r"(?<=[.!?])\s+", passage) if s.strip()]
    output = tone_model()(sentences, truncation=True, batch_size=16)
    result = {label: f"{sum(row['label'].lower() == label for row in output)/len(output):.1%}"
              for label in ("positive", "neutral", "negative")}
    path.write_text(json.dumps(result))
    return result


def eligible_chunks(filings, cutoff):
    eligible = [(filed, parts) for filed, parts in filings if filed <= cutoff]
    if not eligible:
        return ()
    filed, sections = max(eligible, key=lambda row: row[0])
    return tuple((filed, " ".join(words[i:i+300]))
                 for section in sections for words in [section.split()]
                 for i in range(0, len(words), 300))


@lru_cache(maxsize=24)
def lag_llama(values):
    python = os.environ.get("RISK_LAG_PYTHON")
    if not python:
        raise ImportError("Lag-Llama environment is not configured")
    result = subprocess.run([python, str(Path(__file__).with_name("lag_forecast.py"))],
                            input=json.dumps(values), text=True, capture_output=True,
                            timeout=90, check=True)
    return np.asarray(json.loads(result.stdout.splitlines()[-1]))


class AnalysisTools:
    def __init__(self, quarters, cutoff: date, peers, filings, scale=1.0):
        self.cutoff = cutoff
        self.rows = [quarters[end] for end in sorted(quarters) if end <= cutoff]
        for row in self.rows:
            for measure in row.values():
                if measure:
                    validate_cutoff(cutoff, measure.sources)
        self.peers, self.filings, self.scale = peers, filings, scale
        self.evidence, self.log = {}, []

    def number(self, metric, back=0):
        if metric in MONEY:
            return instant(self.rows, metric, back)
        if metric not in FEATURES or back >= len(self.rows):
            return math.nan
        return ratios(self.rows[:len(self.rows)-back])[metric]

    def format(self, metric, number):
        if metric in MONEY:
            return format_money(number * self.scale)
        if metric in {"net_margin", "ocf_margin", "debt_assets"}:
            return format_value(number * 100) + "%"
        return format_value(number)

    def compute(self, name, metric, back, question):
        value = self.number(metric)
        if name == "get_metric":
            value = self.number(metric, back)
            if math.isfinite(value):
                meaning = FEATURES.get(metric, metric.replace("_", " "))
                if metric in {"current_ratio","cash_current_liabilities"}:
                    asset = "current assets" if metric == "current_ratio" else "cash"
                    meaning = f"about {format_value(value * 100)} cents of {asset} for every dollar of bills due soon"
                return self.format(metric, value), f"{meaning}, {back} reported quarters back (0 is latest)"
        elif name == "compare_to_peers":
            peers = np.asarray(self.peers.get(metric, []), dtype=float)
            peers = peers[np.isfinite(peers)]
            if math.isfinite(value) and len(peers):
                return (f"company {self.format(metric, value)}; median {self.format(metric, np.median(peers))}; "
                        f"rank {1 + int(sum(peers > value))} of {len(peers)}",
                        "Sampled sector companies, ranked from highest value to lowest.")
        elif name == "get_trend":
            changes = []
            for lag in (4,8):
                earlier = self.number(metric, lag)
                if not math.isfinite(value) or not math.isfinite(earlier) or not earlier:
                    continue
                change = 100 * (value - earlier) / abs(earlier)
                changes.append(f"{lag} quarters back: {'up' if change > 0 else 'down' if change < 0 else 'flat'} {format_value(abs(change))}%")
            if changes:
                return ", ".join(changes), "Change from the older value to the latest reported value."
        elif name == "distress_score":
            z = self.number("altman_z")
            if math.isfinite(z):
                zone = "distress" if z < 1.1 else "safe" if z > 2.6 else "grey"
                return f"{format_value(z)}, {zone} zone", FEATURES["altman_z"]
        elif name in {"filing_tone", "search_filing"}:
            chunks = eligible_chunks(self.filings, self.cutoff)
            if chunks:
                texts = tuple(text for _, text in chunks)
                if name == "search_filing":
                    vector = index_passages((question or "financial risks",))[0]
                    ranking = np.argsort(-(index_passages(texts) @ vector))[:3]
                    return [texts[i] for i in ranking], "Relevant passages in the latest available filing."
                current = tone(texts)
                filed = chunks[0][0]
                prior = eligible_chunks(self.filings, date(filed.year - 1, filed.month, min(filed.day, 28) if filed.month == 2 else filed.day))
                previous = tone(tuple(text for _, text in prior)) if prior else None
                change = None if previous is None else {
                    label:f"{float(current[label].rstrip('%'))-float(previous[label].rstrip('%')):+.1f}"
                    for label in current
                }
                return {"latest":current,"year_earlier":previous,"change_percentage_points":change}, "Share of sentences by tone, based on a model that reads financial language."
        elif name == "forecast" and metric in {"operating_cash_flow", "revenue"}:
            values = [self.number(metric, lag) for lag in reversed(range(len(self.rows)))]
            values = values[next((i for i in range(len(values)) if all(map(math.isfinite, values[i:]))), len(values)):]
            if len(values) < 12:
                return None, "Not enough consecutive reported quarters for Lag-Llama."
            sample = lag_llama(tuple(values))
            quantiles = np.quantile(sample, [.1,.5,.9], axis=0)
            result = {key:[self.format(metric, v) for v in amounts]
                      for key, amounts in zip(("lower_80_range", "median", "upper_80_range"),quantiles)}
            if metric == "operating_cash_flow" and sum(values[-4:]) > 0:
                result["share_below_half"] = f"{np.mean(sample.sum(axis=1) < sum(values[-4:])/2):.1%}"
            return result, "Four-quarter forecast from a model trained on many time series."
        return None, "No eligible data available for this request."

    def ask(self, name, metric="", quarters_back=0, question=""):
        start = monotonic()
        try:
            value, meaning = self.compute(name, metric, max(0, min(40, quarters_back)), question)
        except Exception as exc:
            value, meaning = None, f"{name} unavailable ({type(exc).__name__}); no value was substituted."
        prefix = "T" if name == "search_filing" else "F"
        key = f"{prefix}{len(self.evidence) + 1}" if value is not None else None
        answer = dict(value=value, plain_meaning=meaning, evidence_id=key)
        if key:
            self.evidence[key] = json.dumps(answer["value"], ensure_ascii=False) + " " + meaning
        self.log.append({"tool":name, "metric":metric, "quarters_back":quarters_back,
                         "question":question, "result":answer, "seconds":monotonic()-start})
        return answer

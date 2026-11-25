"""Matched early-warning pilot on a prediction-date holdout and shared numeric evidence."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import hashlib
import json
from pathlib import Path
from time import monotonic

import numpy as np
import pandas as pd

from research.agents import briefing, check_claim
from research.download import companyfacts
from research.llm import BudgetExceeded, CallFailed, Client
from research.metrics import cluster_auroc, score
from research.packets import numeric_packet
from research.panel import build_quarters


ROOT = Path("results/matched_numeric_pilot")
CUTOFF = "2024-12-31"
BASELINES = ("A0", "A1", "RF", "HGB")
BASELINE_PATH = Path("results/expanded_original_splits_predictions.csv")
ROLES = ("Profitability", "Cash Flow & Debt", "Industry")
PROMPT = (
    "Predict the probability (0 to 100 percent) of any of these four events in the next "
    "four fiscal quarters: positive trailing net income turns negative, positive trailing "
    "operating cash flow falls below half its current level, a common dividend payer cuts "
    "trailing common dividends by at least 25%, or bankruptcy. The facts are anonymized "
    "and some data is missing. Use only these facts. Cite evidence IDs. Keep say to two "
    "brief sentences. Return one probability in risk_percent."
)


def choose_cohort():
    path = ROOT / "cohort.csv"
    if path.exists():
        return pd.read_csv(path)
    # Use every common-baseline case at the specified cutoff, without sampling on labels.
    panel = pd.read_csv("results/panel.csv", usecols=["cik","cutoff","sector"])
    labels = pd.read_csv("results/labels.csv", usecols=["cik","cutoff"])
    baseline = pd.read_csv(BASELINE_PATH, usecols=["cik","cutoff"]+
                           [f"{arm}_score" for arm in BASELINES]).dropna()
    eligible = panel[panel.cutoff == CUTOFF].merge(labels,on=["cik","cutoff"],validate="one_to_one")
    cohort = eligible.merge(baseline[["cik","cutoff"]],on=["cik","cutoff"],validate="one_to_one")
    cohort = cohort[["cik","cutoff","sector"]].sort_values("cik")
    cohort.to_csv(path,index=False)
    return cohort


def case_data(row, panel):
    cutoff = date.fromisoformat(row.cutoff)
    quarters = build_quarters(companyfacts(row.cik),cutoff)
    if len(quarters)<4:
        raise ValueError("Fewer than four reported quarters")
    peers = panel[(panel.cutoff==row.cutoff)&(panel.sector==row.sector)]
    features = ["current_ratio","cash_current_liabilities","debt_assets","interest_coverage",
                "net_margin","roa","ocf_debt","ocf_margin","revenue_growth_yoy",
                "net_margin_change_yoy","debt_assets_change_yoy","altman_z"]
    medians=peers[features].median().to_dict()
    packet=numeric_packet(quarters,cutoff,row.cik,medians)
    # Keep the shared packet compact. Preserve four quarters and all derived features.
    return {key:value for key,value in packet.items() if not value.startswith(
            ("Q-7:","Q-6:","Q-5:","Q-4:"))}


def predict(client, packet):
    single=client("B","Single analyst",1,PROMPT,{"evidence":packet})
    first={role:client("E/D",role,1,PROMPT+f" Your assigned lens is {role}.",
                       {"evidence":packet}) for role in ROLES}
    referee={role:[check_claim(c,packet) for c in answer["claims"]] for role,answer in first.items()}
    rebuttals={}
    for role in ROLES:
        peers={other:briefing(answer) for other,answer in first.items() if other!=role}
        rebuttals[role]=client("D",role,2,PROMPT+
            f" You are {role}. Address a concrete disagreement with a named colleague. Reassess your own probability based on evidence.",
            {"evidence":packet,"own":briefing(first[role]),"peers":peers,"claim_checks":referee})
    verdict=client("D","Moderator",3,PROMPT+
        " Review the independent and revised estimates. Weigh the evidence, decide your own final probability, and explain why.",
        {"evidence":packet,"opening":{r:briefing(a) for r,a in first.items()},
          "rebuttals":{r:briefing(a) for r,a in rebuttals.items()},"claim_checks":referee})
    return {"single":single,"opening":first,"rebuttals":rebuttals,"moderator":verdict,
            "ensemble_p":float(np.mean([r["p"] for r in first.values()]))}


def main():
    ROOT.mkdir(parents=True,exist_ok=True)
    label_path=Path("results/labels.csv")
    digest=hashlib.sha256(label_path.read_bytes()).hexdigest()
    if digest not in Path("results/run_log.md").read_text():
        raise ValueError("Frozen label hash mismatch")
    cohort=choose_cohort()
    panel=pd.read_csv("results/panel.csv")
    done=ROOT/"predictions.jsonl"
    recorded={int(r["cik"]):r for line in done.read_text().splitlines()
              if (r:=json.loads(line)).get("result")} if done.exists() else {}
    client=Client(ROOT/"calls.jsonl",cap=3,prefer_file=True)
    start=monotonic()
    def evaluate(row):
        if row.cik in recorded:
            return recorded[row.cik]
        key={"cik":row.cik,"cutoff":row.cutoff}
        try:
            evidence=case_data(row,panel)
            return {**key,"packet_hash":hashlib.sha256(json.dumps(evidence,sort_keys=True).encode()).hexdigest(),
                    "result":predict(client,evidence)}
        except (OSError,ValueError,CallFailed,BudgetExceeded) as exc:
            return {**key,"error":str(exc)}
    partial=[]
    with ThreadPoolExecutor(max_workers=12) as pool, done.open("a") as stream:
        for row in pool.map(evaluate,cohort.itertuples(index=False)):
            partial.append(row)
            if row["cik"] not in recorded:
                stream.write(json.dumps(row)+"\n")
                stream.flush()
            print(row["cik"],"scored" if "result" in row else row["error"],flush=True)
    labels=pd.read_csv(label_path).set_index(["cik","cutoff"])
    baseline=pd.read_csv(BASELINE_PATH).set_index(["cik","cutoff"])
    matches=[r for r in partial if "result" in r]
    rows=[]
    for r in matches:
        key=(r["cik"],r["cutoff"])
        row=labels.loc[key]
        old=baseline.loc[key]
        if int(row.positive) != int(old.positive):
            raise ValueError(f"Baseline outcome disagrees with frozen label for {key}")
        result=r["result"]
        rows.append({
            "cik":r["cik"],"ticker":row.ticker,"cutoff":r["cutoff"],"observed_distress":int(row.positive),
            **{f"{arm}_score":float(old[f"{arm}_score"]) for arm in BASELINES},
            **{f"{arm}_high":bool(old[f"{arm}_high"]) for arm in BASELINES},
            "single_score":result["single"]["p"],"independent_ensemble_score":result["ensemble_p"],
            "debate_score":result["moderator"]["p"],
        })
    table=pd.DataFrame(rows)
    table.to_csv(ROOT/"case_comparison.csv",index=False)
    y=table.observed_distress if not table.empty else []
    stats={"selected":len(cohort),"matched":len(matches),"positives":int(sum(y)),"cutoff":CUTOFF,
           "model":client.model,"estimated_cost_usd":client.spent,"source":"numeric evidence only",
           "seconds":monotonic()-start,"label_sha256":digest}
    if len(set(y))==2:
        ai=("single","independent_ensemble","debate")
        scores={arm:table[f"{arm}_score"] for arm in (*BASELINES,*ai)}
        ci,delta,skipped=cluster_auroc(y,table.cik,scores,
            [("debate",arm) for arm in scores if arm!="debate"])
        stats.update(metrics={arm:score(y,p,table[f"{arm}_high"] if arm in BASELINES else p>=.5,
                                         None if arm=="A0" else p) for arm,p in scores.items()},
                     auroc_ci=ci,paired_auroc_delta_ci={f"{a}-{b}":v for (a,b),v in delta.items()},
                     skipped_bootstraps=skipped)
    (ROOT/"summary.json").write_text(json.dumps(stats,indent=2)+"\n")
    print(json.dumps(stats,indent=2),flush=True)


if __name__=="__main__":
    main()

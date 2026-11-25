"""Render the evidence figures for the expanded Milestone 2 report."""
from datetime import date
import json
from pathlib import Path
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import pandas as pd
from sklearn.metrics import (average_precision_score, precision_recall_curve, roc_auc_score, roc_curve)

from research.demo import demo_facts
from research.panel import build_quarters

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "m2/evidence/figures"
COLORS = ["#777c83","#315880","#087f76","#a96426"]
ROLES = ["Profitability","Cash Flow & Debt","Industry","Filing Narrative"]
NAMES = ["Altman Z″","Logistic","Random forest","Gradient boosting"]
plt.rcParams.update({"font.size":10,"axes.spines.top":False,"axes.spines.right":False,
                     "axes.labelcolor":"#263238","text.color":"#263238",
                     "axes.titleweight":"bold","font.family":"DejaVu Sans"})


def save(fig, name):
    fig.savefig(OUTPUT/name,dpi=225,bbox_inches="tight",pad_inches=.12)
    plt.close(fig)


def baseline():
    data=pd.read_csv(ROOT/"results/expanded_original_splits_predictions.csv")
    fig,(left,right)=plt.subplots(1,2,figsize=(9.4,3.6),layout="constrained")
    for arm,name,color in zip(("A0","A1","RF","HGB"),NAMES,COLORS):
        scores=data[f"{arm}_score"]
        false_positive,true_positive,_=roc_curve(data.positive,scores)
        precision,recall,_=precision_recall_curve(data.positive,scores)
        left.plot(false_positive,true_positive,label=f"{name} {roc_auc_score(data.positive,scores):.3f}",color=color)
        right.step(recall,precision,label=f"{name} {average_precision_score(data.positive,scores):.3f}",
                   color=color,where="post")
    left.set(xlabel="False positive rate",ylabel="True positive rate")
    right.set(xlabel="Recall",ylabel="Precision")
    left.plot([0,1],[0,1],':',color='#b2b5b8')
    right.axhline(data.positive.mean(),linestyle=':',color='#b2b5b8')
    left.set_title("Ranking performance")
    right.set_title("Precision at different recall levels")
    for ax in (left,right):
        ax.legend(fontsize=7.5,frameon=False)
    save(fig,"baseline_curves.png")


def timeline():
    fig,axes=plt.subplots(1,2,figsize=(9.4,3.55),layout="constrained",sharey=True)
    audit=[]
    for cik,name,color,ax in zip((4904,882184),("American Electric Power","D.R. Horton"),COLORS[2:],axes):
        rows=build_quarters(demo_facts(cik),date(2026,11,24))
        points=[(end,row["operating_cash_flow"].value/1e9) for end,row in rows.items()
                if end>=date(2022,1,1) and row.get("operating_cash_flow")]
        dates,values=zip(*points)
        ax.plot(dates,values,'o-',color=color,ms=3.8,lw=1.9)
        ax.axvspan(date(2025,1,1),date(2026,11,24),color="#e6efed",zorder=0)
        ax.axvline(date(2024,12,31),color='#6c7a7a',linestyle="--",lw=1)
        ax.axhline(0,color='#d2d6d6',lw=.8)
        ax.set_title(name,loc='left')
        ax.xaxis.set_major_locator(mdates.YearLocator())
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
        ax.grid(axis='y',color='#e6e9e9',linewidth=.6)
        ax.set_xlim(date(2022,1,1),date(2026,12,15))
        ax.annotate(f"${values[-1]:.2f}B",xy=(dates[-1],values[-1]),xytext=(-5,9),
                    textcoords="offset points",ha='right',color=color,fontweight="bold")
        for end,value in points:
            audit.append({"cik":cik,"company":name,"fiscal_period_end":end,"operating_cash_flow_billions":value})
    axes[0].set_ylabel("Quarterly cash from operations ($ billions)")
    save(fig,"recent_cash_flow.png")
    pd.DataFrame(audit).to_csv(OUTPUT/"recent_cash_flow_data.csv",index=False)


def votes():
    fig,axes=plt.subplots(1,2,figsize=(9.4,3.55),layout="constrained",sharey=True)
    for label,filename,ax in zip(("AEP | historical","D.R. Horton | Today"),("AEP_historical.md","DHI_today.md"),axes):
        transcript=(ROOT/"m2/evidence"/filename).read_text()
        records=re.findall(r"^## (.+?) · Round (\d+) · (\d+)%",transcript,re.M)
        indexed={(role,int(phase)):int(pct) for role,phase,pct in records}
        for role,color in zip(ROLES,COLORS):
            ax.plot(range(3),[indexed[role,i] for i in (1,2,3)],"o-",label=role,color=color,lw=1.5)
        verdict=indexed["moderator",4]
        ax.scatter(3,verdict,marker='D',color="#243944",s=52,zorder=5)
        ax.annotate(f"{verdict}%",(3,verdict),xytext=(7,0),textcoords="offset points",va='center')
        ax.set_xticks(range(4),["Opening","Rebuttal","Final","Chair"])
        ax.set_title(label,loc="left")
        ax.set_xlim(-.14,3.62)
        ax.set_ylim(0,max(62,max(indexed.values())+7))
        ax.grid(axis='y',color='#e6e9e9',linewidth=.6)
    axes[0].set_ylabel("Risk vote (%)")
    handles,labels=axes[0].get_legend_handles_labels()
    fig.legend(handles,labels,loc='outside lower center',ncol=4,frameon=False,fontsize=8)
    save(fig,"analyst_votes.png")


def dhi_forecast():
    path=ROOT/"m2/evidence/DHI_today.md"
    def parse_amount(value):
        count,unit,_=value.split()
        return float(count)*{"billion":1,"million":.001,"thousand":.000001}[unit]
    def parse_line(line):
        request,result=line.removeprefix("- forecast ").split("}: {",1)
        return json.loads(request+"}"), json.loads("{"+result)
    forecasts=[parse_line(line) for line in path.read_text().splitlines()
               if line.startswith("- forecast {")]
    result=next(result["value"] for request,result in forecasts
                if request["metric"]=="operating_cash_flow" and result["value"])
    lower,median,upper=([parse_amount(v) for v in result[key]]
                        for key in ("lower_80_range","median","upper_80_range"))
    quarters=[1,2,3,4]
    fig,ax=plt.subplots(figsize=(9.4,3.25),layout="constrained")
    ax.fill_between(quarters,lower,upper,color="#d9eae7",label="10th–90th percentile")
    ax.plot(quarters,median,"o-",color=COLORS[2],label="Median forecast",lw=2)
    for quarter,value in zip(quarters,median):
        ax.annotate(f"${value:.2f}B",(quarter,value),xytext=(4,6),textcoords="offset points",fontsize=9)
    ax.set_xticks(quarters,["Next quarter","Quarter +2","Quarter +3","Quarter +4"])
    ax.set_ylabel("Quarterly operating cash flow ($ billions)")
    ax.set_ylim(0,max(upper)*1.12)
    ax.set_title("D.R. Horton | Lag-Llama forecast at the November 2026 cutoff",loc="left")
    ax.legend(loc="upper right",frameon=False)
    ax.grid(axis="y",alpha=.16)
    save(fig,"dhi_cash_flow_forecast.png")


def main():
    OUTPUT.mkdir(exist_ok=True,parents=True)
    baseline()
    timeline()
    votes()
    dhi_forecast()


if __name__=="__main__":
    main()

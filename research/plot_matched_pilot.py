"""Draw matched held-out performance and paired uncertainty."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


ROOT = Path("results/matched_numeric_pilot")
NAMES = {"A0":"Altman Z″","A1":"Logistic","RF":"Random forest","HGB":"Gradient boosting",
         "single":"Single AI","independent_ensemble":"Independent AI ensemble","debate":"AI debate"}


def main():
    result=json.loads((ROOT/"summary.json").read_text())
    metrics=result["metrics"]
    fig,(rank,delta)=plt.subplots(1,2,figsize=(10.5,4.4),layout="constrained")
    for ax in (rank,delta):
        ax.spines[["top","right"]].set_visible(False)
        ax.grid(axis="x",color="#e6ebed",zorder=0)
    for index,(key,label) in enumerate(NAMES.items()):
        score=metrics[key]["auroc"]
        low,high=result["auroc_ci"][key]
        color="#087f76" if key in {"single","independent_ensemble","debate"} else "#62738a"
        rank.errorbar(score,index,xerr=[[score-min(low,score)],[max(high,score)-score]],fmt="o",
                      capsize=3,color=color,zorder=3)
    rank.axvline(.5,ls=":",color="#818c95")
    rank.set_yticks(range(len(NAMES)),list(NAMES.values()))
    rank.invert_yaxis()
    rank.set_title("Performance on the same cases",loc="left")
    rank.set_xlabel("AUROC (95% bootstrap interval)")
    for i,key in enumerate(("single","independent_ensemble","RF")):
        improvement=metrics["debate"]["auroc"]-metrics[key]["auroc"]
        low,high=result["paired_auroc_delta_ci"][f"debate-{key}"]
        delta.errorbar(improvement,i,xerr=[[improvement-min(low,improvement)],
                       [max(high,improvement)-improvement]],fmt="o",capsize=3,color="#087f76",zorder=3)
    delta.axvline(0,ls=":",color="#818c95")
    delta.set_yticks(range(3),["vs. single AI","vs. independent AI ensemble","vs. random forest"])
    delta.invert_yaxis()
    delta.set_title("Debate advantage",loc="left")
    delta.set_xlabel("Paired change in AUROC (95% interval)")
    fig.suptitle(f"December 2024 | {result['matched']} companies, {result['positives']} distress events",
                 x=.05,ha="left",fontweight="bold")
    fig.savefig(ROOT/"matched_comparison.png",dpi=220,bbox_inches="tight")
    plt.close(fig)


if __name__=="__main__":
    main()

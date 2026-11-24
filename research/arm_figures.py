"""Render the milestone's ROC, precision-recall, calibration and sector panels."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.metrics import precision_recall_curve, roc_auc_score, roc_curve


COLORS = {
    "A0": "#555555", "A1": "#725fa7", "B": "#157675",
    "C": "#2e68ad", "E": "#bb661a", "D": "#a0314e",
}


def figures(y, scores, sectors, directory):
    directory.mkdir(exist_ok=True, parents=True)
    fig, (roc, pr) = plt.subplots(1, 2, figsize=(10, 4), layout="constrained")
    for arm, rank in scores.items():
        fpr, tpr, _ = roc_curve(y, rank)
        precision, recall, _ = precision_recall_curve(y, rank)
        roc.plot(fpr, tpr, color=COLORS[arm], label=arm)
        pr.step(recall, precision, color=COLORS[arm], label=arm, where="post")
    roc.plot([0, 1], [0, 1], ":", color="#777777")
    pr.axhline(y.mean(), linestyle=":", color="#777777")
    roc.set(xlabel="False positive rate", ylabel="True positive rate")
    pr.set(xlabel="Recall", ylabel="Precision")
    roc.legend(frameon=False, loc="lower right")
    fig.savefig(directory / "fig3.png", dpi=200)
    plt.close(fig)

    fig, (calibration, by_sector) = plt.subplots(1, 2, figsize=(10, 4), layout="constrained")
    for arm, values in scores.items():
        if arm == "A0":
            continue
        observed, predicted = calibration_curve(y, values, n_bins=5, strategy="quantile")
        calibration.plot(predicted, observed, marker="o", color=COLORS[arm], label=arm)
    calibration.plot([0, 1], [0, 1], ":", color="#777777")
    calibration.set(xlabel="Mean predicted probability", ylabel="Observed event rate")
    sectors = np.asarray(sectors)
    names = [name for name in sorted(set(sectors)) if len(np.unique(y[sectors == name])) == 2]
    sector_scores = {}
    for offset, (arm, rank) in enumerate(scores.items()):
        rank = np.asarray(rank)
        results = {name: roc_auc_score(y[sectors == name], rank[sectors == name]) for name in names}
        sector_scores[arm] = results
        by_sector.scatter(list(results.values()), np.arange(len(names)) + (offset - 2.5) * .10,
                          color=COLORS[arm], marker="o", s=13, label=arm)
    by_sector.set(yticks=np.arange(len(names)), yticklabels=names, xlim=(0, 1), xlabel="AUROC")
    by_sector.axvline(.5, linestyle=":", color="#777777")
    by_sector.legend(frameon=False, ncol=3)
    fig.savefig(directory / "fig4.png", dpi=200)
    plt.close(fig)
    return sector_scores

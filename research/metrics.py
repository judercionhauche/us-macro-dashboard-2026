"""Matched-cohort metrics and paired company-cluster bootstrap intervals."""
import math

import numpy as np
from sklearn.metrics import (
    average_precision_score, balanced_accuracy_score, brier_score_loss,
    f1_score, roc_auc_score,
)


def score(y, rank, high, probability=None):
    y, rank, high = np.asarray(y), np.asarray(rank), np.asarray(high)
    if not (len(y) == len(rank) == len(high)) or len(np.unique(y)) != 2:
        raise ValueError("Scores must align to a cohort containing both outcomes")
    if not np.isfinite(rank).all() or not np.isin(high, (False, True)).all():
        raise ValueError("Every included observation needs a valid rank and decision")
    # Break score ties using the shared, presorted company/date row order.
    reviewed = np.argsort(-rank, kind="stable")[:math.ceil(len(y) * 0.2)]
    return {
        "auroc": roc_auc_score(y, rank),
        "pr_auc": average_precision_score(y, rank),
        "recall_at_20": float(y[reviewed].sum() / y.sum()),
        "f1": f1_score(y, high, zero_division=0),
        "balanced_accuracy": balanced_accuracy_score(y, high),
        "brier": None if probability is None else brier_score_loss(y, probability),
    }


def cluster_auroc(y, companies, scores, comparisons, reps=2000, seed=244):
    y, companies = np.asarray(y), np.asarray(companies)
    scores = {arm: np.asarray(rank) for arm, rank in scores.items()}
    if len(companies) != len(y) or any(len(rank) != len(y) for rank in scores.values()):
        raise ValueError("Company IDs and arm scores must align to the same observations")
    groups = [np.flatnonzero(companies == company) for company in np.unique(companies)]
    if len(groups) < 2 or len(np.unique(y)) != 2:
        raise ValueError("Cluster bootstrap needs multiple companies and both outcome classes")
    random = np.random.default_rng(seed)
    draws = []
    skipped = 0
    for _ in range(reps):
        ix = np.concatenate([groups[i] for i in random.integers(len(groups), size=len(groups))])
        if len(np.unique(y[ix])) != 2:
            skipped += 1
            continue
        draws.append([roc_auc_score(y[ix], rank[ix]) for rank in scores.values()])
    if not draws:
        raise ValueError("All bootstrap replicates lacked one outcome class")
    draws = dict(zip(scores, np.asarray(draws).T))
    intervals = {arm: np.quantile(values, [0.025, 0.975]).tolist()
                 for arm, values in draws.items()}
    paired = {(a, b): np.quantile(draws[a] - draws[b], [0.025, 0.975]).tolist()
              for a, b in comparisons}
    return intervals, paired, skipped

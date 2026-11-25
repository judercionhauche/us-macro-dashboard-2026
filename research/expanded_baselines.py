"""Exploratory nonlinear baselines and a calendar-gap sensitivity check."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.pipeline import make_pipeline

from research.baselines import FEATURES, TrainingWinsorizer, fit_logistic
from research.metrics import cluster_auroc, score


GRIDS = {
    "RF": [{"max_depth": d, "min_samples_leaf": l}
           for d in (3, 6, None) for l in (10, 25)],
    "HGB": [{"max_leaf_nodes": size, "min_samples_leaf": leaf}
            for size in (7, 15) for leaf in (15, 30)],
}


def model(name, settings):
    if name == "RF":
        estimator = RandomForestClassifier(n_estimators=300, random_state=244, n_jobs=2,
                                           class_weight="balanced", **settings)
    else:
        estimator = HistGradientBoostingClassifier(max_iter=100, learning_rate=.05,
            l2_regularization=1, early_stopping=False, class_weight="balanced", random_state=244,
            **settings)
    return make_pipeline(TrainingWinsorizer(),
                         SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
                         estimator)


def fit(name, train, validation):
    features = list(FEATURES)
    years = train["cutoff"].str[:4].astype(int)
    folds = [(train[years < y], train[years == y]) for y in sorted(set(years))[1:]]
    folds = [(a,b) for a,b in folds if a.positive.nunique() == b.positive.nunique() == 2]
    def objective(settings):
        return np.mean([roc_auc_score(b.positive,
            model(name, settings).fit(a[features], a.positive).predict_proba(b[features])[:,1])
            for a,b in folds])
    best = max(GRIDS[name], key=objective)
    fitted = model(name, best).fit(train[features],train.positive)
    probs = fitted.predict_proba(validation[features])[:,1]
    threshold = max(np.unique(probs), key=lambda t:(f1_score(validation.positive,probs>=t),t))
    return fitted, best, float(threshold)


def main():
    root = Path("results")
    label_file = root / "labels.csv"
    if hashlib.sha256(label_file.read_bytes()).hexdigest() not in (root/"run_log.md").read_text():
        raise ValueError("Label hash mismatch")
    labels = pd.read_csv(label_file).drop(columns="ticker")
    keys = ["cik","cutoff"]
    panel = pd.read_csv(root/"panel.csv").merge(labels,on=keys,validate="one_to_one").sort_values(keys)
    original = pd.read_csv(root/"baseline_predictions.csv").dropna(subset=["A0_score"])
    original_settings = json.loads((root/"preliminary_baselines.json").read_text())
    test = panel.merge(original.drop(columns="positive"),on=keys,validate="one_to_one").sort_values(keys)
    year = panel.cutoff.str[:4].astype(int)
    out = {}
    for protocol, train, val in (
        ("original_splits", panel[year<=2021], panel[year==2022]),
        ("calendar_gap", panel[year<=2020], panel[year==2021]),
    ):
        exported=test[keys + ["positive"]].copy()
        scores = {"A0":test.A0_score.to_numpy()}
        flags = {"A0":test.A0_high.astype(bool).to_numpy()}
        if protocol=="original_splits":
            scores["A1"], flags["A1"] = test.A1_score.to_numpy(), test.A1_high.astype(bool).to_numpy()
            config={"A1":{"C":original_settings["LR_C"],"threshold":original_settings["threshold"]}}
        else:
            lr,c,t=fit_logistic(train,val)
            scores["A1"]=lr.predict_proba(test[list(FEATURES)])[:,1]
            flags["A1"]=scores["A1"]>=t
            config={"A1":{"C":c,"threshold":t}}
        for name in GRIDS:
            fitted,best,t=fit(name,train,val)
            scores[name]=fitted.predict_proba(test[list(FEATURES)])[:,1]
            flags[name]=scores[name]>=t
            config[name]={**best,"threshold":t}
        ci, delta, skipped=cluster_auroc(test.positive,test.cik,scores,
                                        [("RF","A1"),("HGB","A1")])
        for name in scores:
            exported[name+"_score"]=scores[name]
            exported[name+"_high"]=flags[name]
        exported.to_csv(root/f"expanded_{protocol}_predictions.csv",index=False)
        out[protocol]={"n":len(test),"positives":int(test.positive.sum()),
                       "train":len(train),"validation":len(val),"config":config,"intervals":ci,
                       "paired_delta_intervals":{f"{a}-{b}":v for (a,b),v in delta.items()},
                       "bootstrap_skipped":skipped,
                       "metrics":{a:score(test.positive,s,flags[a],None if a=="A0" else s)
                                  for a,s in scores.items()}}
    (root/"expanded_baselines.json").write_text(json.dumps(out,indent=2,allow_nan=False)+"\n")
    print(json.dumps(out,indent=2))


if __name__=="__main__":
    main()

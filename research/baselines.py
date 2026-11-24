"""Milestone 2 conventional models on a frozen company-quarter panel."""
import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


FEATURES = (
    "current_ratio", "cash_current_liabilities", "debt_assets", "interest_coverage",
    "net_margin", "roa", "ocf_debt", "ocf_margin", "revenue_growth_yoy",
    "net_margin_change_yoy", "debt_assets_change_yoy", "altman_z",
    "log_assets", "loss_flag", "dividend_payer_flag",
)
C_GRID = (0.001, 0.01, 0.1, 1.0, 10.0, 100.0)


def altman_z(assets, current_assets, current_liabilities, retained, ebit_ttm,
             equity, liabilities):
    # Terms are defined only when their denominators are positive.
    if assets <= 0 or liabilities <= 0:
        return np.nan
    return (
        6.56 * (current_assets - current_liabilities) / assets
        + 3.26 * retained / assets
        + 6.72 * ebit_ttm / assets
        + 1.05 * equity / liabilities
    )


def altman_predictions(panel):
    """Z double-prime below 1.1 is High. Its rank score is not a probability."""
    z = panel["altman_z"].astype(float)
    return panel.assign(score=-z, high=(z < 1.1).where(z.notna()))


class TrainingWinsorizer(TransformerMixin, BaseEstimator):
    """Learn clipping bounds only from the observations used to fit the model."""
    def fit(self, x, y=None):
        self.lower_ = x.quantile(.01)
        self.upper_ = x.quantile(.99)
        return self

    def transform(self, x):
        return x.clip(self.lower_, self.upper_, axis="columns")


def _logistic(c):
    return make_pipeline(
        TrainingWinsorizer(),
        SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
        StandardScaler(),
        LogisticRegression(C=c, class_weight="balanced", max_iter=2000, random_state=244),
    )


def fit_logistic(train, validation):
    """Choose C on expanding training folds and use 2022 solely for the threshold."""
    features = list(FEATURES)
    x_train, y_train = train[features], train["positive"]
    x_val, y_val = validation[features], validation["positive"]
    if y_train.nunique() != 2 or y_val.nunique() != 2:
        raise ValueError("Both training and validation must contain both outcome classes")
    years = train["cutoff"].str[:4].astype(int)
    folds = [(years < year, years == year) for year in sorted(years.unique())[1:]]
    folds = [(earlier, later) for earlier, later in folds
             if y_train[earlier].nunique() == 2 and y_train[later].nunique() == 2]
    if not folds:
        raise ValueError("No expanding training fold contains both outcome classes")
    aucs = {}
    for c in C_GRID:
        fold_aucs = []
        for earlier, later in folds:
            model = _logistic(c).fit(x_train[earlier], y_train[earlier])
            p = model.predict_proba(x_train[later])[:, 1]
            fold_aucs.append(roc_auc_score(y_train[later], p))
        aucs[c] = np.mean(fold_aucs)
    c = max(C_GRID, key=aucs.get)
    model = _logistic(c).fit(x_train, y_train)
    p = model.predict_proba(x_val)[:, 1]
    threshold = max(np.unique(p), key=lambda t: (f1_score(y_val, p >= t), t))
    return model, c, float(threshold)


def logistic_predictions(model, threshold, panel):
    p = model.predict_proba(panel.loc[:, list(FEATURES)])[:, 1]
    return panel.assign(score=p, high=p >= threshold)

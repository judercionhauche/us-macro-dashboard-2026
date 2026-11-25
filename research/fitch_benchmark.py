"""Compare archived Fitch issuer grades with frozen forecasts on common cases."""
import csv
from datetime import date
import gzip
from hashlib import sha256
from io import StringIO
import json
from pathlib import Path
import re
import unicodedata

import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from research.metrics import cluster_auroc, score


SOURCE = Path("m2/evidence/human_benchmark")
PILOT = Path("results/matched_numeric_pilot/case_comparison.csv")
OUT = Path("results/human_benchmark")
SNAPSHOT = "2024-12-01"
CUTOFF = "2024-12-31"
ARCHIVE_HASH = "a5a9e30a9b5e6d90afc54d33071b3ead876fc7c016dad9f3b587f36341fe5485"
GRADES = "AAA AA+ AA AA- A+ A A- BBB+ BBB BBB- BB+ BB BB- B+ B B- CCC+ CCC CCC- CC C RD D".split()
ARMS = ("Fitch", "single", "independent_ensemble", "debate", "A0", "A1", "RF", "HGB")
AI_ARMS = ("single", "independent_ensemble", "debate")


def name_key(name):
    name = unicodedata.normalize("NFKC", name).upper()
    name = re.sub(r"\s*/(?:NY|DE|TX)\s*/?\s*$", "", name)
    name = re.sub(r"\bCORP\b", "CORPORATION", name)
    name = re.sub(r"\bINC\b", "INCORPORATED", name)
    name = re.sub(r"\bAND\b", "&", name)
    return re.sub(r"[^A-Z0-9&]", "", name)


def read_archive():
    raw = gzip.decompress((SOURCE / "fitch_corporate_20241201.csv.gz").read_bytes())
    if sha256(raw).hexdigest() != ARCHIVE_HASH:
        raise ValueError("Fitch archive checksum differs from the source manifest")
    records = list(csv.DictReader(StringIO(raw.decode("utf-8-sig"))))
    if {row["file_creating_date"] for row in records} != {SNAPSHOT}:
        raise ValueError("Unexpected Fitch snapshot date")
    return [
        row for row in records
        if row["rating_type"] == "Long Term Issuer Default Rating"
        and row["obligor_sec_category"] == "Corporate"
        and not row["object_type_rated"]
        and row["obligor_name"]
        and row["rating_action_date"] <= SNAPSHOT
    ]


def resolve(issuer, archive):
    cik, name = (issuer[k] for k in ("cik", "sec_registrant"))
    key = name_key(name)
    matches = [
        row for row in archive
        if row["central_index_key"].lstrip("0") == cik
        or (not row["central_index_key"] and name_key(row["obligor_name"]) == key)
    ]
    audit = {**issuer, "match_status": "no_parent_grade_in_archive", "fitch_obligor": "",
             "fitch_lei": "", "fitch_grade": "", "rating_action_date": "",
             "rating_action_class": "", "match_method": "", "rating_age_days": None,
             "Fitch_score": None}
    if not matches:
        return audit
    latest = max(row["rating_action_date"] for row in matches)
    last_rows = [row for row in matches if row["rating_action_date"] == latest]
    names = {name_key(row["obligor_name"]) for row in matches}
    leis = {row["legal_entity_identifier"] for row in matches if row["legal_entity_identifier"]}
    grades = {row["rating"] for row in last_rows}
    if len(names) != 1 or len(leis) > 1 or len(grades) != 1:
        return {**audit, "match_status": "ambiguous_history"}
    last = last_rows[0]
    grade = last["rating"]
    audit.update(
        fitch_obligor=last["obligor_name"].strip('"'),
        fitch_lei=last["legal_entity_identifier"],
        fitch_grade=grade,
        rating_action_date=latest,
        rating_action_class=" / ".join(sorted({row["rating_action_class"] for row in last_rows})),
        match_method="CIK" if any(row["central_index_key"] for row in matches) else "registrant name",
        rating_age_days=(date.fromisoformat(CUTOFF) - date.fromisoformat(latest)).days,
    )
    if grade == "WD" or any(row["rating_action_class"] == "WO" for row in last_rows):
        return {**audit, "match_status": "withdrawn"}
    if grade in GRADES:
        return {**audit, "match_status": "scored", "Fitch_score": GRADES.index(grade)}
    return {**audit, "match_status": "unrecognized_grade"}


def apply_dividend_audit(cases):
    """Correct four verified false dividend-only flags without changing the frozen file."""
    id_columns = ["cik", "ticker", "cutoff"]
    labels = pd.read_csv("results/labels.csv", dtype={"cik": str})
    overrides = pd.read_csv(SOURCE / "dividend_label_audit.csv", dtype={"cik": str})
    joined = cases.merge(labels, on=id_columns, validate="one_to_one")
    if len(joined) != len(cases) or not joined["observed_distress"].equals(joined["positive"]):
        raise ValueError("Pilot outcomes do not agree with the frozen labels")
    joined = joined.merge(overrides[id_columns + ["finding"]], on=id_columns,
                          how="left", validate="one_to_one")
    corrected = joined["finding"].notna()
    if corrected.sum() != len(overrides) or not (
        joined.loc[corrected, ["e1", "e2", "e3", "bankruptcy"]] == [0, 0, 1, 0]
    ).all().all():
        raise ValueError("Audit rows must match observed dividend-only events")
    joined = joined.rename(columns={"observed_distress": "frozen_distress"})
    joined["observed_distress"] = joined["frozen_distress"].where(~corrected, 0)
    return joined.drop(columns=["split", "positive"])


def evaluate(cases, arms=ARMS, comparison_arm="Fitch"):
    y = cases["observed_distress"].to_numpy()
    result = {"companies": len(cases), "events": int(y.sum()),
              "rating_grades": cases.loc[cases["match_status"] == "scored", "fitch_grade"].nunique()}
    if len(set(y)) != 2:
        return result
    scores = {arm: cases[f"{arm}_score"].to_numpy() for arm in arms}
    comparisons = [(arm, comparison_arm) for arm in arms if arm != comparison_arm]
    intervals, paired, skipped = cluster_auroc(y, cases["cik"], scores, comparisons)
    result["metrics"] = {
        arm: {"auroc": roc_auc_score(y, scores[arm]), "auroc_ci": intervals[arm],
              "average_precision": average_precision_score(y, scores[arm])}
        for arm in arms
    }
    for arm in scores.keys() - {"Fitch"}:
        high = cases[f"{arm}_high"] if arm not in AI_ARMS else scores[arm] >= 0.5
        result["metrics"][arm].update(score(y, scores[arm], high))
    result["paired_vs_" + comparison_arm] = {
        arm: {"delta": result["metrics"][arm]["auroc"] - result["metrics"][other]["auroc"],
              "ci": paired[arm, other]}
        for arm, other in comparisons
    }
    result["skipped_bootstraps"] = skipped
    return result


def omit_one_event(cases):
    """Check whether one realized event drives the apparent Fitch advantage."""
    deltas = {}
    for case in cases[cases["observed_distress"] == 1].itertuples():
        subset = cases[cases["cik"] != case.cik]
        y = subset["observed_distress"]
        fitch = roc_auc_score(y, subset["Fitch_score"])
        deltas[case.ticker] = {
            arm: fitch - roc_auc_score(y, subset[f"{arm}_score"])
            for arm in AI_ARMS
        }
    return deltas


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    archive = read_archive()
    with (SOURCE / "sec_issuers.csv").open(newline="") as stream:
        audit = pd.DataFrame(resolve(issuer, archive) for issuer in csv.DictReader(stream))
    audit.to_csv(OUT / "rating_match_audit.csv", index=False)

    predictions = pd.read_csv(PILOT, dtype={"cik": str})
    if set(predictions["cutoff"]) != {CUTOFF}:
        raise ValueError("Expected a single common cutoff")
    cases = audit.merge(predictions, on=["cik", "ticker"], validate="one_to_one")
    if not len(audit) == len(predictions) == len(cases):
        raise ValueError("Issuer audit and pilot cohort differ")
    cases = apply_dividend_audit(cases)
    shared = cases[cases["match_status"] == "scored"]
    recent = shared[shared["rating_action_date"] >= "2021-12-31"]
    cases.to_csv(OUT / "pilot_audited_outcomes.csv", index=False)
    shared.to_csv(OUT / "case_comparison.csv", index=False)
    result = {
        "archive_date": SNAPSHOT, "prediction_date": CUTOFF, "archive_sha256": ARCHIVE_HASH,
        "full_pilot_companies": len(cases), "full_pilot_frozen_events": int(cases["frozen_distress"].sum()),
        "match_counts": audit["match_status"].value_counts().to_dict(),
        "median_rating_age_days": float(shared["rating_age_days"].median()),
        "oldest_rating_age_days": int(shared["rating_age_days"].max()),
        "full_pilot_audited": evaluate(cases, ARMS[1:], "single"),
        "shared_frozen": evaluate(shared.assign(observed_distress=shared["frozen_distress"])),
        "shared": evaluate(shared), "within_three_years": evaluate(recent),
        "fitch_minus_ai_auroc_omitting_one_event": omit_one_event(shared),
    }
    (OUT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()

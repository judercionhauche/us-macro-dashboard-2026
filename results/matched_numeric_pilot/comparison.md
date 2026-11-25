# Matched historical AI comparison (original outcome file)

Prediction date: December 31, 2024. Complete common cohort: 64 companies, 12 events flagged in the original outcome file. The [dividend audit](../../m2/evidence/human_benchmark/CHECKPOINT.md) corrected four flags. See the [audited scores](../human_benchmark/summary.json) for the figures used in the final report.

| Method | AUROC | Average precision | Recall at top 20% | F1 |
|---|---:|---:|---:|---:|
| Altman Z″ | 0.551 | 0.304 | 16.7% | 0.231 |
| Logistic regression | 0.548 | 0.230 | 16.7% | 0.350 |
| Random forest | 0.577 | 0.238 | 25.0% | 0.267 |
| Histogram gradient boosting | 0.548 | 0.215 | 16.7% | 0.286 |
| Single AI analyst | 0.566 | 0.215 | 16.7% | 0.333 |
| Three independent AI analysts (average) | 0.583 | 0.230 | 16.7% | 0.244 |
| Three analysts + rebuttals + moderator | 0.549 | 0.205 | 8.3% | 0.311 |

Paired AUROC change, debate minus single AI: -0.017 (95% bootstrap interval -0.108 to +0.071).

The point estimate favors the single AI analyst. The interval includes both an advantage and a disadvantage for debate.

Protocol: all three AI arms used gpt-4o-mini and the same anonymized, date-filtered numerical packet for each case. The independent ensemble averages the same opening votes used by the debate. The debate adds rebuttals and a moderator. The historical filing archive did not have consistent coverage, so this comparison isolates the numeric-evidence setting. It does not measure RAG or comparative performance across other cutoff dates.

AUROC measures ranking. Recall at top 20% measures how many of the 12 event cases a reviewer would find when screening the 13 highest-risk cases. AI F1 uses the study’s 50% High threshold. Conventional baselines retain their earlier thresholds.

All 64 matched cases completed. Estimated API cost: $0.23.

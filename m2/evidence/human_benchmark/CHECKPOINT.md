# Human credit-analyst benchmark checkpoint

Saved November 24, 2026.

## Completed AI experiment

- All 64 common December 31, 2024 cases completed. The original outcome file flagged 12 events; the dividend audit below corrected that count to eight.
- AUROC: single AI 0.566; average of three independent AI analysts 0.583; debate 0.549.
- Paired difference, debate minus single AI: −0.017 (95% interval −0.108 to +0.071).
- Full outputs: `results/matched_numeric_pilot/comparison.md`, `case_comparison.csv`, `summary.json`, and `matched_comparison.png` in the same results directory.

## Human comparison sources

Fitch ratings reflect published credit analysts’ judgments about default risk. They are an independent ranking proxy for this project’s broader distress definition, not direct predictions of the four-event label.

- `fitch_corporate_20241201.csv.gz` — December 1, 2024 archived snapshot (primary candidate; predates cutoff).
  Source: https://ratingshistory.info/api/public/20241201%20Fitch%20Ratings%20Corporate.csv
  SHA-256 of uncompressed CSV: `a5a9e30a9b5e6d90afc54d33071b3ead876fc7c016dad9f3b587f36341fe5485`.
- `fitch_corporate_20260701.csv.gz` — July 1, 2026 snapshot (reference only; post-cutoff archive).
  Source: https://ratingshistory.info/api/public/20260701%20Fitch%20Ratings%20Corporate.csv
  SHA-256 of uncompressed CSV: `0822b3a55c9e68bb1164e7be2dce8f087eb89e49451f196edb5e0ecafa3eff21`.

Disclosure methodology: https://www.sec.gov/about/divisions-offices/office-credit-ratings/disclosure-of-credit-rating-histories

## Completed November 24, 2026

### Reproducing from a fresh checkout

Fetch the dated corporate archive directly from the source before running the script:

```sh
curl --fail --silent --show-error --location \
  'https://ratingshistory.info/api/public/20241201%20Fitch%20Ratings%20Corporate.csv' \
  --output /tmp/m2_fitch_corporate_20241201.csv
gzip -c /tmp/m2_fitch_corporate_20241201.csv \
  > m2/evidence/human_benchmark/fitch_corporate_20241201.csv.gz
```

The benchmark checks the SHA-256 of the downloaded CSV. The public repository includes the
issuer-level matching audit and comparison outputs. The full archive contains instrument-level
records, and the July 2026 reference snapshot is not needed to reproduce the analysis.

Run `python -m research.fitch_benchmark` from the project root. The script verifies the December archive checksum, matches parent-company issuer grades using `sec_issuers.csv`, checks the joined pilot labels against the frozen file, and emits match, case and score audits under `results/human_benchmark/`. It makes no API calls. The July 2026 snapshot was excluded.

The original pilot had 12 flagged events on 64 companies. Primary issuer records disproved four dividend-only flags for Lumen, McDonald’s, Tractor Supply and Entergy. See `dividend_label_audit.csv` for the evidence and `results/human_benchmark/pilot_audited_outcomes.csv` for the original and corrected outcome per company. The outcome audit did not refit models or revise the original frozen label file. The earlier 533-observation experiment uses that original panel and needs a wider dividend audit and refit.

| Evaluation | Companies | Audited events | Single AI AUROC | Three independent AI AUROC | Debate AUROC | Fitch AUROC |
|---|---:|---:|---:|---:|---:|---:|
| December 2024 pilot | 64 | 8 | 0.531 | 0.551 | 0.506 | — |
| Shared issuer-grade subset | 32 | 5 | 0.507 | 0.522 | 0.470 | 0.700 |
| Rating action within three years | 12 | 2 | 0.400 | 0.525 | 0.450 | 0.625 |

The 64-company debate-minus-single difference was −0.026 AUROC (95% paired bootstrap interval −0.136 to +0.071). On 32 shared cases, debate minus Fitch was −0.230 (−0.434 to −0.018). The newer-action sensitivity estimate was −0.175 (−0.500 to +0.136). Missing and withdrawn grades make coverage selective. Archived actions can lag the issuer’s actual rating, and the latest observed action was a median 3.6 years old. Fitch ranks credit default risk. The audited outcome also includes losses, cash-flow declines and common-dividend cuts.

RAG was used to retrieve company disclosures in the existing voice demonstration. The scored AI arms had no access to Fitch grades or human credit commentary. An independent human benchmark and a test of adding human commentary answer different research questions.

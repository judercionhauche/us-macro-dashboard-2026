
- Frozen labels at `labels.csv`, 2128 observations, SHA-256 `9f1792eaec07b1d41aad5e7fd10157614375eb03003d895cb879cc14982c625c`.

## Inputs and cohort

- Membership authority: [fja05680 updated historical CSV](https://github.com/fja05680/sp500/blob/master/S%26P%20500%20Historical%20Components%20%26%20Changes%20%28Updated%29.csv). The 505 December 2018 tickers matched [the second source's 2019 starting snapshot](https://github.com/shardul0701/SP500-Survivorship-bias-data-2004-2026/blob/main/src/sp500_ticker_history/sp500-ticker-changes-2019.yaml) after ticker punctuation normalization.
- CIK and sector crosswalk: [current GICS file](https://github.com/datasets/s-and-p-500-companies/blob/main/data/constituents.csv), [archived 2019 list](https://github.com/fja05680/sp500/blob/e608eca239b709f1a21b8a5011db8af4b6149dcb/sp500.csv), and historical overrides in `research/historical_crosswalk.csv`. WestRock uses CIK 1732845 based on its 2018 succession filing.
- The sampling frame contained 394 eligible issuers. The draw contained 100 issuers, of which 29 had left-index flags based on constituent ticker removals. A ticker removal can represent an issuer rename or reorganization.
- The SEC cutoff panel retained 2,313 of 2,500 planned observations across 99 issuers. With outcome follow-up and censoring applied, the frozen set retained 2,128 rows across 98 issuers, including 435 positives. The 2023–2024 test set contains 673 labeled rows, 128 positive.
- Acquisition censoring uses control-change and acquisition disclosures corroborated by reporting cessation and Form 15. The manifest records dates and sources. No bankruptcy filings within an eligible outcome window entered the frozen labels.

## Evaluation

- A0 and A1 scored 533 shared test rows. A0 requires a complete Z″ calculation. A1 winsorized at the fitting fold’s 1st and 99th percentiles, used balanced class weights and selected C from 0.001, 0.01, 0.1, 1, 10 and 100 using mean expanding-fold AUROC inside 2018–2021. The 2022 validation split set the threshold by F1. The corrected figures supersede the initial validation-based pilot baseline. See `preliminary_baselines.json`. These are baseline-only results.
- The ten-observation LLM pilot could not start. The SEC primary document server returned HTTP 403 on all ten filing retrievals. Direct complete-submission text also returned 403. No paid calls were attempted.
- Sector medians for packet preparation come from the 100-company sample. The local narrative extraction and anonymisation code needs verification on historical filing HTML before use in a paid run.
- The adjusted-price check matched 1,793 of 2,128 frozen observations using Yahoo Finance after Stooq returned a browser challenge. Positive versus negative median 12-month total returns were -7.1% versus 10.1% (Mann–Whitney p=5.4e-13), and median maximum drawdowns were -33.8% versus -23.3% (p=3e-27). This comparison applies to price-covered observations.
- The DOCX template now describes the referee step and sampled-firm sector medians. Report fill and PDF export require the missing LLM results; the template still contains its result keys.

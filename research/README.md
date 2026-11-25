# BUS 244A Milestone 2

The S&P 500 study is an offline project. Use Python with NumPy, pandas,
scikit-learn, SciPy, Matplotlib and Beautiful Soup. The document fill script
also requires python-docx, and PDF export requires LibreOffice.

The checked-in run artifacts document the source cross-check, sample, eligibility
filters and frozen outcomes. The freeze command refuses to overwrite an existing
labels file. Baseline and LLM runners verify its SHA-256 against the run log.

Use `RISK_CACHE_DIR` to reuse an external data cache. SEC downloads use a generic
study identifier by default. `RISK_SEC_USER_AGENT` accepts an approved contact
identifier when available. The two SEC endpoints for company facts and submissions
are cached separately from primary filing HTML.

From the repository root:

```sh
python -m research.sample --membership /path/to/membership.csv \
  --metadata research/historical_crosswalk.csv /path/to/current-gics.csv /path/to/archived-2019.csv \
  --out results/sample.csv
python -m research.build_panel
python -m research.audit_filings --out /path/to/filings-audit.json
python -m research.event_manifest /path/to/filings-audit.json results/corporate_events.csv
python -m research.freeze_labels --events results/corporate_events.csv
python -m research.evaluate_baselines
python -m research.eda
python -m research.prices
python -m unittest discover -s research -v
```

Once the original filing documents are available, validate that the extracted
passages exclude issuer identifiers before sending the evidence to the provider.
Prepare ten test packets with `python -m research.prepare_packets --filings
/path/to/filings-audit.json --limit 10` and run the pilot with
`python -m research.run_agents --pilot --full-test-size 533`. Prepare the full
cohort by omitting `--limit`, then run agents without `--pilot`. The pilot
chooses the full or four-date evaluation cohort. See `results/run_log.md` for
the current run and its data-access blocker.

For already downloaded, verified SEC primary documents, point
`RISK_FILING_DIR` to a directory containing `<accession-number>.html` files.
The packet builder still checks the accession's filing date against the cutoff
using the original SEC filing index.

## Watch the dashboard

Launch the integrated dashboard locally with `python -m research.demo` and open
`http://127.0.0.1:8790/`. Use the same `RISK_CACHE_DIR` as the data run to
reuse downloaded SEC company facts. The S&P 500 Risk Lab and Macro Dashboard
share the existing page and styles. Run the existing macro Worker dev server on
port 8787 when using the macro tools locally.

Select **Class demo** for real-dollar evidence, a named introduction and the
frozen-outcome reveal. The default **Research** presentation scales dollars and
uses an anonymous introduction. Both modes keep company identifiers and dates
out of the analyst prompts. Browser sessions have separate ledgers from scored
research, with estimated-spend caps of $1 for analyst calls and $0.45 for speech.
Keys come from the environment or the git-ignored `worker/.dev.vars`.

Filing Narrative requires excerpts from the latest eligible report. AEP's
December 2024 cutoff uses the issuer's copy of the [September 2024 Form 10-Q](https://docs.aep.com/docs/investors/AEP10Q20243Q.pdf),
matched to accession `0000004904-24-000100`, filed November 6, 2024. A verified
issuer mirror can be cached in `$RISK_CACHE_DIR/demo-filings/<accession>.json`
with `accession`, `filed`, `url` and `paragraphs` fields. For another case,
supply the eligible SEC filing through `RISK_FILING_DIR` if direct SEC access
fails. A missing filing is reported before the panel starts.

The API writes every spoken turn, including the host segments. The class-demo opening sends the company and date to a separate moderator
call. Neither is included in any analyst tool or prompt.
The outcome goes only to a separate host call after the moderator votes.

Playback starts with **Start voice debate**. Results appear after the moderator
finishes speaking and, in demo mode, the historical outcome is revealed. The
latest completed class demo is written to `results/demo_transcript.md`.

## Tool-grounded demo and class models

The live panel rotates four analysts over openings, rebuttals and final votes.
Each analyst selects up to three analysis requests before answering. The transcript
logs the requests, returned values, claim checks, turns, words and speaking time.
Today mode uses the latest eligible reports and has no outcome reveal.

The server expects local Hugging Face caches for
`sentence-transformers/all-MiniLM-L6-v2`, `ProsusAI/finbert` and
`time-series-foundation-models/Lag-Llama`. Set `HF_HOME` to the downloaded models
and `RISK_LAG_PYTHON` to a Python 3.11 environment with official Lag-Llama and
`setuptools<81`. Older GluonTS and Lightning dependencies are isolated from the dashboard's
Python. Model tools return an unavailable result when they cannot produce a value.
Set `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1` for the tested Mac setup.

AEP’s issuer text can supplement the SEC company-facts feed with
`python -m research.aep_filing_facts 2026-06-30=/path/to/june.txt
2026-09-30=/path/to/september.txt`. The script uses the original 10-Q filing date
for each extracted row. The data stays outside the repo in the study cache.

The optional `--tool-grounded` switch for the research pilot and evaluator keeps
its output files separate. B and C receive the same tool menu and differ in the
evidence their prompts tell them to consult first. Approve that protocol change
before using it for scored results. The frozen label file stays the same.

## Share a recorded debate

`python -m research.export_replay --historical /path/to/historical.jsonl --today
/path/to/today.jsonl --output /path/to/risk-demo` exports both verified recordings,
including audio, charts, and tool summaries, as a static site. It does not need
API credentials or the local demo server. Serve the output under `risk-demo/`
on GitHub Pages. The Python server remains the entry point for new live runs.
The export includes a historical study snapshot so visitors can use the company
and cutoff selectors even when the live service is unavailable. If the
historical panel or audited Fitch benchmark changes, regenerate the files with
`python -m research.risk_study`.

## Public live deployment

The Pages export accepts `--public-api https://YOUR-WORKER.workers.dev/risk` to
point the frontend at the existing Worker. The Worker streams from a Python
relay over HTTPS. Start a separate loopback-only Python instance using
`RISK_RELAY_ONLY=1`, `RISK_RELAY_SECRET` and `RISK_DEMO_PORT`. Connect it using
a Cloudflare Tunnel or an HTTPS host that can run the model dependencies.
Set `RISK_UPSTREAM`, `RISK_RELAY_SECRET` and `RISK_VIEWER_KEY` as Worker
secrets. Use an independent random value for each secret. Send the viewer link
privately with `#access=VIEWER_KEY` in the fragment. Provider keys stay on the
Python host. Its debate cap and single-run lock still apply.

The Pages frontend also has a recording option that works while the Python
host is offline. The existing macro routes continue to use their own settings.

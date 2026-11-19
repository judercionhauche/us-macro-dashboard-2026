# US Macro Dashboard 2026 — AI Economic Policy Lab

A static frontend (`index.html`, `app.js`, `lab.js`, `voice-debate.js`) and a Cloudflare Worker backend (`worker/src`). The Lab runs a simulated monetary-policy committee in the style of *FOMC In Silico* (Kazinnik & Sinclair, 2026). It is a simulation, not an official Federal Reserve forecast.

## Data pipeline (per meeting cutoff)

| Source | What | Access | Historical accuracy |
|---|---|---|---|
| ALFRED (St. Louis Fed) | GDP, IP, retail sales, housing starts, CPI/core CPI, PCE/core PCE, unemployment, payrolls, participation, hourly earnings, emp-pop ratio | free, no key | **real-time vintage** as of cutoff − 1 day |
| FRED | fed funds, 2y/10y yields, WTI, VIX, dollar, S&P 500 | free, no key | market data (not revised), dated < cutoff |
| BLS Public Data API | unemployment, payrolls, participation, avg hourly earnings, emp-pop | v1 keyless (25 req/day) or v2 with `BLS_API_KEY` | current revised values (no vintages); conservative release-lag rule; cross-checked against ALFRED |
| federalreserve.gov | latest FOMC statement before the cutoff; Board speeches in the 45 days before it | free, public | dated strictly before the cutoff |
| FRED (model) | VAR estimation data | free | revised values, truncated by publication lag (see limitations) |

Code: `worker/src/lab/sources/{http,alfred,bls,fed}.js` → `worker/src/lab/snapshot.js` (schema: `raw` / `derived` / `issues`, every record cites its URL, observation date, vintage and retrieval time) → `committee.js` (rule inputs use as-published values; agents' briefing includes compact extracts with URLs) → UI *Research details → Data sources and citations*.

## Setup

```
# optional secrets in worker/.dev.vars (git-ignored) or `wrangler secret put NAME`
OPENAI_API_KEY=...        # live AI agents and voices (otherwise demo mode, $0)
BLS_API_KEY=...           # optional: BLS v2 limits (free at data.bls.gov/registrationEngine)
LAB_BUDGET_USD=5          # hard cap on estimated paid spending (LLM + speech)
LAB_PAID_CALLS=off        # optional no-cost mode: refuse every paid call
```
Run locally: `node worker/dev-server.mjs` then open `http://localhost:8787/?api=http://localhost:8787`. Source data and the spending counter are cached in `~/.cache/us-macro-dashboard/` (override with `LAB_CACHE_DIR`), outside the project so VS Code Live Server doesn't reload the page during a debate.

## Tests (mocked, no cost)

```
cd worker && node test/sources.test.mjs && node test/voice.test.mjs && node test/committee.test.mjs
```
(`committee.test.mjs` reads live public FRED/official data but makes no paid calls.)

No-cost smoke test (one snapshot + one rule-based meeting, paid calls disabled):
```
node worker/scripts/smoke.mjs 2019-07-25
```

## Known limitations
- VAR coefficients and its forecast origin use today's revised FRED data (truncated by publication lag); the policy rules and the agents' briefing use ALFRED vintages.
- BLS offers no vintages or release dates; its values are today's official values, used for the latest snapshot and as a revision cross-check.
- Speeches: Board members only (the Fed's speech index), extracts are deterministic keyword-based excerpts; Reserve Bank presidents' speeches are not included.
- The in-app spending cap is an estimate from token/character counts; set a hard limit in the provider dashboard too.

// Data-source adapters, cutoff enforcement, caching, snapshot schema, agent integration and the
// spending cap. All network calls are MOCKED — no live services, no cost.
// Run: node test/sources.test.mjs
import assert from "node:assert/strict";
import { fetchText, cached, redact, _clearMemoryCache, SourceError } from "../src/lab/sources/http.js";
import { alfredVintage, parseFredCsv } from "../src/lab/sources/alfred.js";
import { blsLabor, parseBls } from "../src/lab/sources/bls.js";
import { latestStatement, recentSpeeches, parseSpeechIndex, statementLinks } from "../src/lab/sources/fed.js";
import { buildSnapshot, snapshotBriefing, SCHEMA_VERSION, MACRO, MARKET } from "../src/lab/snapshot.js";
import { rulePrescriptions, runMeeting } from "../src/lab/committee.js";
import { reserve, record, budgetStatus, _resetBudgetForTests } from "../src/lab/budget.js";

const FAST = { LAB_HTTP_BACKOFF_MS: "1", LAB_HTTP_TIMEOUT_MS: "200" };
let calls = [];
let routes = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, init });
  for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
  return new Response("not found", { status: 404 });
};
const reset = (r) => { routes = r; calls = []; _clearMemoryCache(); _resetBudgetForTests(); };
const csv = (id, rows) => new Response(`observation_date,${id}\n` + rows.map(([d, v]) => `${d},${v}`).join("\n"));
const monthly = (start, n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1 + i, 1)); return [d.toISOString().slice(0, 10), f(i)]; });
const page = (body) => new Response(`<html><body><div id="article"><p>June 19, 2019 Federal Reserve issues FOMC statement For release at 2:00 p.m. EDT Share</p>${body}</div><div id="lastUpdate">x</div></body></html>`);
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("  ✓", name); };

/* ---------- http ---------- */
await t("fetchText retries 503 then succeeds; never retries 404", async () => {
  let k = 0; reset([[/flaky/, () => (++k < 2 ? new Response("busy", { status: 503 }) : new Response("ok"))]]);
  assert.equal(await fetchText("https://x/flaky", { env: FAST }), "ok"); assert.equal(k, 2);
  reset([]); await assert.rejects(fetchText("https://x/missing", { env: FAST }), (e) => e.status === 404); assert.equal(calls.length, 1);
});
await t("fetchText times out and gives up after the retry limit", async () => {
  reset([[/slow/, (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))]]);
  await assert.rejects(fetchText("https://x/slow", { env: FAST, retries: 1 }), /timeout/); assert.equal(calls.length, 2);
});
await t("credentials are redacted from URLs", () => {
  assert.equal(redact("https://a?api_key=SECRET&x=1"), "https://a?api_key=REDACTED&x=1");
});
await t("cache: second call is served without a request; records keep retrievedAt", async () => {
  reset([]); let loads = 0;
  const a = await cached({}, "k", Infinity, async () => ++loads), b = await cached({}, "k", Infinity, async () => ++loads);
  assert.equal(loads, 1); assert.equal(b.cached, true); assert.equal(a.retrievedAt, b.retrievedAt);
});

/* ---------- ALFRED ---------- */
await t("ALFRED: vintage URL, parsing, permanent cache for historical vintages", async () => {
  reset([[/alfredgraph/, (u) => csv("UNRATE_20190724", [["2019-05-01", "3.6"], ["2019-06-01", "3.7"], ["2019-07-01", "."]])]]);
  const r = await alfredVintage(FAST, "UNRATE", "2019-07-24");
  assert.match(calls[0].url, /id=UNRATE&vintage_date=2019-07-24/); assert.equal(r.obs.length, 2);
  await alfredVintage(FAST, "UNRATE", "2019-07-24"); assert.equal(calls.length, 1, "no re-download");
});
await t("ALFRED: malformed CSV is an error, not silent data", () => {
  assert.throws(() => parseFredCsv("<html>error</html>"), SourceError);
});

/* ---------- BLS ---------- */
const blsOk = { status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "LNS14000000", data: [
  { year: "2019", period: "M07", value: "3.7", footnotes: [{}] }, { year: "2019", period: "M06", value: "3.7", footnotes: [{ text: "preliminary" }] },
  { year: "2019", period: "M05", value: "3.6", footnotes: [{}] }, { year: "2019", period: "M13", value: "3.7", footnotes: [{}] }] }] } };
await t("BLS: keyless v1 without BLS_API_KEY; release-lag cutoff drops months not yet published", async () => {
  reset([[/api\.bls\.gov/, () => new Response(JSON.stringify(blsOk))]]);
  const r = await blsLabor(FAST, "2019-07-25");
  assert.match(calls[0].url, /publicAPI\/v1\//); assert.ok(!calls[0].init.body.includes("registrationkey"));
  assert.deepEqual(r.series.LNS14000000.map((o) => o.date), ["2019-05-01"], "June released in July → excluded for a July cutoff; M13 annual average ignored");
});
await t("BLS: v2 with key sends the key in the POST body, never in the URL", async () => {
  reset([[/api\.bls\.gov/, () => new Response(JSON.stringify(blsOk))]]);
  await blsLabor({ ...FAST, BLS_API_KEY: "k123" }, "2019-08-25");
  assert.match(calls[0].url, /v2/); assert.ok(!calls[0].url.includes("k123")); assert.ok(calls[0].init.body.includes("k123"));
});
await t("BLS: rate limit and malformed responses raise clear errors", async () => {
  assert.throws(() => parseBls({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold reached"] }), (e) => e.status === 429);
  reset([[/api\.bls\.gov/, () => new Response("<html>oops</html>")]]);
  await assert.rejects(blsLabor(FAST, "2019-07-25"), /not JSON/);
});

/* ---------- Federal Reserve ---------- */
const cal = `<a href="/newsevents/pressreleases/monetary20190501a.htm">x</a><a href="/newsevents/pressreleases/monetary20190619a.htm">x</a><a href="/newsevents/pressreleases/monetary20190731a.htm">x</a><a href="/newsevents/pressreleases/monetary20190731a.htm">dup</a>`;
await t("statements: calendar links deduplicated; picks latest strictly before cutoff", async () => {
  assert.equal(statementLinks(cal).length, 3);
  reset([[/fomccalendars|fomchistorical2019/, () => new Response(cal)], [/monetary20190619a/, () => page(`<p>${"Information received since the Federal Open Market Committee met ".repeat(6)}</p><p>In support of these goals, the Committee decided to maintain the target range for the federal funds rate at 2-1/4 to 2-1/2 percent.</p>`)]]);
  const st = await latestStatement(FAST, "2019-07-31");
  assert.equal(st.date, "2019-06-19", "same-day statement is NOT eligible"); assert.match(st.decisionParagraph, /target range/); assert.match(st.url, /^https:\/\/www\.federalreserve\.gov\//);
});
await t("statements: unavailable statement page surfaces an error", async () => {
  reset([[/fomccalendars|fomchistorical/, () => new Response(cal)]]);
  await assert.rejects(latestStatement(FAST, "2019-07-31"), (e) => e.status === 404);
});
const index = JSON.stringify([
  { d: "7/16/2019 1:00:00 PM", t: "Monetary Policy &amp; the Economy", s: "Chair Jerome H. Powell", l: "/newsevents/speech/powell20190716a.htm" },
  { d: "7/16/2019 1:00:00 PM", t: "dup", s: "Chair Jerome H. Powell", l: "/newsevents/speech/powell20190716a.htm" },
  { d: "7/31/2019 1:00:00 PM", t: "After the meeting", s: "Governor X", l: "/newsevents/speech/x20190731a.htm" },
  { t: "missing date", s: "Governor Y", l: "/newsevents/speech/y.htm" },
  { d: "7/11/2019 1:00:00 PM", t: "Gone", s: "Governor Lael Brainard", l: "/newsevents/speech/brainard20190711a.htm" }]);
await t("speeches: malformed entries skipped, deduplicated, nothing on/after cutoff, missing text reported", async () => {
  assert.equal(parseSpeechIndex("﻿" + index).length, 3);
  reset([[/ne-speeches\.json/, () => new Response(index)], [/powell20190716a/, () => page(`<p>${"Inflation has run below our symmetric 2 percent objective and the labor market remains strong ".repeat(3)}</p>`)]]);
  const r = await recentSpeeches(FAST, "2019-07-31");
  assert.deepEqual(r.speeches.map((s) => s.date), ["2019-07-16", "2019-07-11"]);
  assert.equal(r.speeches[0].title, "Monetary Policy & the Economy"); assert.match(r.speeches[0].extract, /Inflation/);
  assert.equal(r.speeches[1].textAvailable, false);
});

/* ---------- snapshot ---------- */
function fullRoutes({ future = false } = {}) {
  return [
    [/alfredgraph/, (u) => { const id = /id=([A-Z0-9]+)/.exec(u)[1]; const rows = monthly("2017-01-01", 30, (i) => (id === "UNRATE" ? 3.7 : id === "PCEPILFE" ? 100 * 1.016 ** (i / 12) : 100 + i)); if (future) rows.push(["2019-08-01", "9.9"]); return csv(id, rows); }],
    [/fredgraph/, (u) => { const id = /id=([A-Z0-9]+)/.exec(u)[1]; return csv(id, [["2018-07-24", "2.0"], ["2019-07-24", "2.4"]]); }],
    [/api\.bls\.gov/, () => new Response(JSON.stringify(blsOk))],
    [/fomccalendars|fomchistorical2019/, () => new Response(cal)],
    [/monetary20190619a/, () => page(`<p>${"Information received since the Federal Open Market Committee met in May ".repeat(6)}</p><p>The Committee decided to maintain the target range for the federal funds rate.</p>`)],
    [/ne-speeches\.json/, () => new Response(index)],
    [/powell20190716a/, () => page(`<p>${"Inflation pressures remain muted and the outlook for monetary policy is uncertain ".repeat(3)}</p>`)],
  ];
}
await t("snapshot: schema, citations, raw vs derived separation, all sources connected", async () => {
  reset(fullRoutes());
  const s = await buildSnapshot(FAST, { asOf: "2019-07-25" });
  assert.equal(s.schemaVersion, SCHEMA_VERSION); assert.equal(s.mode, "historical"); assert.equal(s.cutoff, "2019-07-25");
  assert.equal(s.raw.indicators.length, MACRO.length + MARKET.length);
  for (const r of s.raw.indicators) { assert.ok(r.url && r.retrievedAt && r.observationDate < s.cutoff); }
  assert.ok(s.raw.indicators.filter((r) => r.vintageDate).every((r) => r.vintageDate === "2019-07-24"));
  assert.ok(s.derived.every((d) => d.formula && d.from), "derived values say how they were computed");
  assert.ok(s.raw.labor.length >= 1 && s.raw.statement && s.raw.speeches.length === 2);
  const corePce = s.derived.find((d) => d.id === "corePce"); assert.ok(Math.abs(corePce.value - 1.6) < 0.01);
  const brief = snapshotBriefing(s);
  assert.match(brief, /monetary20190619a\.htm/); assert.match(brief, /powell20190716a\.htm/); assert.ok(brief.length < 6000, "compact extract, not full documents");
});
await t("snapshot: leakage guard drops observations dated on/after the cutoff", async () => {
  reset(fullRoutes({ future: true }));
  const s = await buildSnapshot(FAST, { asOf: "2019-07-25" });
  assert.ok(!JSON.stringify(s.raw.indicators.map((r) => r.observationDate)).includes("2019-08"));
});
await t("snapshot: failing sources become recorded issues, never fabricated values", async () => {
  reset([[/alfredgraph/, () => new Response("down", { status: 503 })]]);
  const s = await buildSnapshot(FAST, { asOf: "2019-07-25" });
  assert.equal(s.derived.filter((d) => MACRO.some((m) => m.id === d.id)).length, 0);
  assert.ok(s.issues.some((i) => i.source === "ALFRED") && s.issues.some((i) => i.source === "BLS"));
});
await t("agents: policy rules use the snapshot's as-published inputs", async () => {
  reset(fullRoutes());
  const s = await buildSnapshot(FAST, { asOf: "2019-07-25" });
  const model = { conditions: { policyRate: 2.375, coreInflation: 9, unemployment: 9, unemployment12mAgo: 9, naturalUnemployment: 4.4, naturalUnemployment12mAgo: 4.4 },
    meta: { horizon: 2 }, scenarios: Object.fromEntries(["-50", "-25", "0", "25", "50"].map((k) => [k, { infl: { mean: [2, 2] }, u: { mean: [4, 4] } }])) };
  const r = rulePrescriptions(model, s);
  assert.ok(Math.abs(r.inputs.pi - 1.6) < 0.01); assert.equal(r.inputs.u, 3.7); assert.match(r.inputs.dataSource, /as first published/);
  assert.equal(rulePrescriptions(model).inputs.pi, 9, "without a snapshot the existing behavior is unchanged");
});

/* ---------- budget ---------- */
await t("budget: refuses paid calls that would exceed the cap; no-cost mode blocks all paid calls", async () => {
  reset([]);
  await reserve({ LAB_BUDGET_USD: "0.01" }, 0.005); await record({ LAB_BUDGET_USD: "0.01" }, 0.009);
  await assert.rejects(reserve({ LAB_BUDGET_USD: "0.01" }, 0.005), (e) => e.status === 402);
  await assert.rejects(reserve({ LAB_PAID_CALLS: "off" }, 0), /disabled/);
  assert.equal((await budgetStatus({ LAB_BUDGET_USD: "0.01" })).remainingUsd, 0.001);
});
await t("budget: an over-budget live meeting sends ZERO requests to the LLM and falls back to rules", async () => {
  reset([]);
  const model = { conditions: { policyRate: 2.375, coreInflation: 1.6, coreInflation12mAgo: 1.9, unemployment: 3.7, unemployment12mAgo: 3.9, naturalUnemployment: 4.4, naturalUnemployment12mAgo: 4.4, ipGrowth: 1, gdpGrowth: 2, dataMonth: "2019-06" },
    meta: { horizon: 24, holdMonths: 6 }, history: { series: { infl: [1.6] } },
    scenarios: Object.fromEntries(["-50", "-25", "0", "25", "50"].map((k) => [k, Object.fromEntries(["infl", "u", "ip", "gdp", "ffr"].map((v) => [v, { mean: Array(24).fill(2), p10: Array(24).fill(1), p90: Array(24).fill(3), effect: Array(24).fill(0.01), effectLo: Array(24).fill(-0.1), effectHi: Array(24).fill(0.1) }]))])) };
  const m = await runMeeting({ OPENAI_API_KEY: "k", LAB_BUDGET_USD: "0" }, model, {});
  assert.equal(calls.filter((c) => /openai|anthropic/.test(c.url)).length, 0);
  assert.ok(m.initial.every((p) => p.source === "fallback")); assert.match(m.initial[0].error, /Spending cap/);
});
console.log(`SOURCE TESTS PASSED (${n})`);

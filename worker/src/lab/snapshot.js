// lab/snapshot.js — one structured, cited, cutoff-safe data snapshot per meeting.
//
// Cutoff rule: information must be published STRICTLY BEFORE the meeting cutoff date.
//   * Macro series: ALFRED vintage as of (cutoff − 1 day) → values as originally published.
//   * Market series: FRED observations dated ≤ cutoff − 1 day (these series are not revised).
//   * BLS: current official values (the API has no vintages), months released before the cutoff
//     month only; used as the primary labor source for the latest snapshot, and as a
//     cross-check ("revised since publication") in historical snapshots.
//   * FOMC statement: latest statement dated < cutoff. Speeches: Board speeches dated < cutoff.
// Layout: raw (source records + citations) / derived (computed indicators, with formulas) /
// issues (missing data, conflicts, limitations). Agent interpretations never live here.

import { alfredVintage, fredUpTo } from "./sources/alfred.js";
import { blsLabor, BLS_SERIES } from "./sources/bls.js";
import { latestStatement, recentSpeeches } from "./sources/fed.js";
import { addDays } from "./sources/http.js";

export const SCHEMA_VERSION = 1;

// Paper, Table 1 (FOMC In Silico): growth, prices, labor, financial conditions.
export const MACRO = [
  { id: "gdp", label: "Real GDP", series: "GDPC1", group: "Growth & output", transform: "yoy", lag: 4 },
  { id: "indpro", label: "Industrial production", series: "INDPRO", group: "Growth & output", transform: "yoy", lag: 12 },
  { id: "retail", label: "Retail sales", series: "RSAFS", group: "Growth & output", transform: "yoy", lag: 12 },
  { id: "housing", label: "Housing starts (thousands, SAAR)", series: "HOUST", group: "Growth & output", transform: "level" },
  { id: "cpi", label: "CPI inflation", series: "CPIAUCSL", group: "Inflation & prices", transform: "yoy", lag: 12 },
  { id: "coreCpi", label: "Core CPI inflation", series: "CPILFESL", group: "Inflation & prices", transform: "yoy", lag: 12 },
  { id: "pce", label: "PCE inflation", series: "PCEPI", group: "Inflation & prices", transform: "yoy", lag: 12 },
  { id: "corePce", label: "Core PCE inflation", series: "PCEPILFE", group: "Inflation & prices", transform: "yoy", lag: 12 },
  { id: "unemployment", label: "Unemployment rate", series: "UNRATE", group: "Labor market", transform: "level", bls: "LNS14000000" },
  { id: "payrolls", label: "Payroll change (thousands, monthly)", series: "PAYEMS", group: "Labor market", transform: "diff", bls: "CES0000000001" },
  { id: "participation", label: "Labor force participation", series: "CIVPART", group: "Labor market", transform: "level", bls: "LNS11300000" },
  { id: "hourlyEarnings", label: "Average hourly earnings growth", series: "CES0500000003", group: "Labor market", transform: "yoy", lag: 12, bls: "CES0500000003" },
  { id: "empPop", label: "Employment-population ratio", series: "EMRATIO", group: "Labor market", transform: "level", bls: "LNS12300000" },
];
export const MARKET = [
  { id: "fedFunds", label: "Effective fed funds rate", series: "DFF" },
  { id: "tsy10", label: "10-year Treasury yield", series: "DGS10" },
  { id: "tsy2", label: "2-year Treasury yield", series: "DGS2" },
  { id: "wti", label: "WTI crude oil ($/bbl)", series: "DCOILWTICO" },
  { id: "vix", label: "VIX volatility index", series: "VIXCLS" },
  { id: "dollar", label: "Trade-weighted dollar (broad)", series: "DTWEXBGS" },
  { id: "sp500", label: "S&P 500", series: "SP500" },
];

const r3 = (x) => Math.round(x * 1000) / 1000;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

function derive(spec, obs) {
  const last = obs[obs.length - 1];
  if (spec.transform === "level") {
    const yearAgo = obs.find((o) => o.date >= addDays(last.date, -366)) || null;
    return { value: last.value, changeYoY: yearAgo ? r3(last.value - yearAgo.value) : null, formula: "latest level; change vs ~12 months earlier (pp)" };
  }
  if (spec.transform === "diff") {
    const prev = obs[obs.length - 2];
    return prev ? { value: r3(last.value - prev.value), formula: "latest month minus previous month" } : null;
  }
  const base = obs[obs.length - 1 - spec.lag];
  return base ? { value: r3((last.value / base.value - 1) * 100), formula: `percent change vs ${spec.lag} periods earlier` } : null;
}

export async function buildSnapshot(env = {}, { asOf = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = asOf || today;
  const vintage = addDays(cutoff, -1);
  const since = addDays(cutoff, -900);
  const snap = { schemaVersion: SCHEMA_VERSION, cutoff, mode: asOf ? "historical" : "latest", generatedAt: new Date().toISOString(),
    rule: "Only information published strictly before the cutoff date.", raw: { indicators: [], labor: [], statement: null, speeches: [] }, derived: [], issues: [] };
  const issue = (source, message, kind = "missing") => snap.issues.push({ source, kind, message });

  // Macro (ALFRED vintages)
  const macro = await pool(MACRO, 4, async (spec) => {
    try { return { spec, ...(await alfredVintage(env, spec.series, vintage, { since })) }; }
    catch (e) { issue("ALFRED", `${spec.label} (${spec.series}): ${e.message}`); return { spec, obs: null }; }
  });
  for (const m of macro) {
    if (!m.obs?.length) continue;
    const last = m.obs[m.obs.length - 1];
    snap.raw.indicators.push({ id: m.spec.id, source: "ALFRED (real-time vintage)", seriesId: m.spec.series, vintageDate: vintage,
      observationDate: last.date, value: last.value, recent: m.obs.slice(-14), url: m.url, retrievedAt: m.retrievedAt });
    const d = derive(m.spec, m.obs);
    if (d) snap.derived.push({ id: m.spec.id, label: m.spec.label, group: m.spec.group, observationDate: last.date, ...d, from: `ALFRED ${m.spec.series} @ ${vintage}` });
  }

  // Market (FRED, unrevised)
  const market = await pool(MARKET, 4, async (spec) => {
    try { return { spec, ...(await fredUpTo(env, spec.series, vintage, { since: addDays(cutoff, -400) })) }; }
    catch (e) { issue("FRED", `${spec.label} (${spec.series}): ${e.message}`); return { spec, obs: null }; }
  });
  for (const m of market) {
    if (!m.obs?.length) continue;
    const last = m.obs[m.obs.length - 1];
    const yearAgo = m.obs.find((o) => o.date >= addDays(last.date, -366));
    snap.raw.indicators.push({ id: m.spec.id, source: "FRED (market data, not revised)", seriesId: m.spec.series, vintageDate: null,
      observationDate: last.date, value: last.value, url: m.url, retrievedAt: m.retrievedAt });
    snap.derived.push({ id: m.spec.id, label: m.spec.label, group: "Financial conditions", observationDate: last.date, value: last.value,
      changeYoY: yearAgo ? r3(last.value - yearAgo.value) : null, formula: "latest daily value; change vs ~1 year earlier", from: `FRED ${m.spec.series} ≤ ${vintage}` });
  }

  // BLS labor (official, current values) + cross-check against the vintage
  try {
    const bls = await blsLabor(env, cutoff);
    for (const [sid, meta] of Object.entries(BLS_SERIES)) {
      const obs = bls.series[sid] || [];
      if (!obs.length) { issue("BLS", `${meta.label} (${sid}): no observations released before the cutoff`); continue; }
      const last = obs[obs.length - 1];
      const rec = { id: meta.key, source: `BLS Public Data API ${bls.api}`, seriesId: sid, observationDate: last.date, value: last.value,
        preliminary: last.preliminary, valueType: "current official (revised) value", url: `https://data.bls.gov/timeseries/${sid}`, retrievedAt: bls.retrievedAt };
      snap.raw.labor.push(rec);
      const spec = MACRO.find((s) => s.bls === sid);
      const alf = spec && snap.raw.indicators.find((x) => x.id === spec.id);
      const same = alf?.recent?.find((o) => o.date === last.date);
      if (same && Math.abs(same.value - last.value) > (sid.startsWith("CES0000") ? 1 : 0.05)) {
        if (snap.mode === "historical") issue("BLS vs ALFRED", `${meta.label} ${last.date}: ${same.value} as first published (used) vs ${last.value} today (later revision)`, "revision");
        else issue("BLS vs FRED", `${meta.label} ${last.date}: BLS ${last.value} vs FRED ${same.value}`, "conflict");
      }
    }
    if (snap.mode === "latest") {
      // Latest snapshot: BLS is the primary labor source (as in the paper) when it is at least as recent.
      for (const rec of snap.raw.labor) {
        const d = snap.derived.find((x) => x.id === rec.id);
        if (d && rec.observationDate >= d.observationDate && ["unemployment", "participation", "empPop"].includes(rec.id)) {
          Object.assign(d, { value: rec.value, observationDate: rec.observationDate, from: `BLS ${rec.seriesId}` });
        }
      }
    }
  } catch (e) { issue("BLS", e.message); }

  // FOMC statement + Board speeches
  try {
    const st = await latestStatement(env, cutoff);
    if (st) snap.raw.statement = st; else issue("Federal Reserve", "No FOMC statement found before the cutoff");
  } catch (e) { issue("Federal Reserve", `FOMC statement: ${e.message}`); }
  try {
    const sp = await recentSpeeches(env, cutoff);
    snap.raw.speeches = sp.speeches;
    sp.speeches.filter((s) => !s.textAvailable).forEach((s) => issue("Federal Reserve", `Speech text unavailable: ${s.url} (${s.error})`));
    if (!sp.speeches.length) issue("Federal Reserve", `No Board speeches in the ${sp.windowDays} days before the cutoff`);
  } catch (e) { issue("Federal Reserve", `Speeches: ${e.message}`); }

  // Leakage guard (defensive): drop anything dated on/after the cutoff.
  const before = (d) => !d || d < cutoff;
  snap.raw.indicators = snap.raw.indicators.filter((x) => before(x.observationDate) && (!x.vintageDate || x.vintageDate < cutoff));
  snap.raw.speeches = snap.raw.speeches.filter((s) => before(s.date));
  if (snap.raw.statement && !before(snap.raw.statement.date)) snap.raw.statement = null;
  if (snap.mode === "latest") snap.issues.push({ source: "note", kind: "info", message: "Latest snapshot: values as currently published." });
  return snap;
}

const snapCache = new Map();
export async function getSnapshot(env, { asOf = null } = {}) {
  const key = asOf || `latest|${new Date().toISOString().slice(0, 13)}`;
  if (!snapCache.has(key)) snapCache.set(key, buildSnapshot(env, { asOf }).catch((e) => { snapCache.delete(key); throw e; }));
  if (snapCache.size > 40) snapCache.delete(snapCache.keys().next().value);
  return snapCache.get(key);
}

// Compact, source-grounded text for agent prompts (no full documents).
export function snapshotBriefing(snap, { maxSpeeches = 4 } = {}) {
  if (!snap) return "";
  const fmt = (d) => `${d.label}: ${d.value}${/rate|inflation|growth|participation|ratio|yield/i.test(d.label) ? "%" : ""}${d.changeYoY != null ? ` (12m change ${d.changeYoY >= 0 ? "+" : ""}${d.changeYoY})` : ""} [${d.observationDate}]`;
  const groups = [...new Set(snap.derived.map((d) => d.group))];
  const lines = [`DATA SNAPSHOT (only information published before ${snap.cutoff}; ${snap.mode === "historical" ? "values as first published (ALFRED vintages)" : "latest published values"}):`];
  for (const g of groups) lines.push(`- ${g}: ` + snap.derived.filter((d) => d.group === g).map(fmt).join("; "));
  if (snap.raw.statement) lines.push(`LATEST FOMC STATEMENT (${snap.raw.statement.date}, ${snap.raw.statement.url}): "${snap.raw.statement.decisionParagraph}"`);
  const sp = snap.raw.speeches.filter((s) => s.textAvailable).slice(0, maxSpeeches);
  if (sp.length) {
    lines.push("RECENT BOARD SPEECHES (short extracts):");
    sp.forEach((s) => lines.push(`- ${s.speaker}, "${s.title}" (${s.date}, ${s.url}): "${s.extract.split(/\s+/).slice(0, 60).join(" ")}…"`));
  }
  return lines.join("\n");
}

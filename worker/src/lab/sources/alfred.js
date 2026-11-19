// sources/alfred.js — FRED / ALFRED adapter (St. Louis Fed). No API key needed.
//  * Macro series: ALFRED real-time vintages — the series exactly as published on the vintage
//    date (https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=X&vintage_date=YYYY-MM-DD).
//  * Market series (yields, oil, VIX, ...) are not revised; they come from FRED with an
//    explicit end date (coed) so no observation after the cutoff can enter.
// Historical vintages never change, so they are cached permanently.

import { fetchText, cached, SourceError, addDays } from "./http.js";

const ALFRED = "https://alfred.stlouisfed.org/graph/alfredgraph.csv";
const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export function parseFredCsv(text, source = "FRED") {
  const lines = String(text || "").trim().split(/\r?\n/);
  if (lines.length < 2 || !/^observation_date,|^DATE,/i.test(lines[0])) throw new SourceError(`${source}: malformed CSV`, { source });
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(",");
    const v = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && raw !== "" && raw !== "." && Number.isFinite(v)) out.push({ date, value: v });
  }
  return out;
}

// Series as it was known at the end of `vintageDate` (observations published after it are absent).
export async function alfredVintage(env, seriesId, vintageDate, { since } = {}) {
  const url = `${ALFRED}?id=${encodeURIComponent(seriesId)}&vintage_date=${vintageDate}${since ? `&cosd=${since}` : ""}`;
  const today = new Date().toISOString().slice(0, 10);
  const ttl = vintageDate < addDays(today, -2) ? Infinity : 6 * 3600 * 1000;
  const rec = await cached(env, `alfred|${seriesId}|${vintageDate}|${since || ""}`, ttl, async () => {
    const obs = parseFredCsv(await fetchText(url, { env, source: "ALFRED" }), "ALFRED");
    if (!obs.length) throw new SourceError(`ALFRED: no observations for ${seriesId} at vintage ${vintageDate}`, { source: "ALFRED" });
    return obs;
  });
  return { obs: rec.value, url, retrievedAt: rec.retrievedAt, cached: rec.cached };
}

// Unrevised market series up to and including `endDate`.
export async function fredUpTo(env, seriesId, endDate, { since } = {}) {
  const url = `${FRED}?id=${encodeURIComponent(seriesId)}&coed=${endDate}${since ? `&cosd=${since}` : ""}`;
  const today = new Date().toISOString().slice(0, 10);
  const ttl = endDate < addDays(today, -2) ? Infinity : 6 * 3600 * 1000;
  const rec = await cached(env, `fred|${seriesId}|${endDate}|${since || ""}`, ttl, async () => {
    const obs = parseFredCsv(await fetchText(url, { env, source: "FRED" }), "FRED").filter((o) => o.date <= endDate);
    if (!obs.length) throw new SourceError(`FRED: no observations for ${seriesId} up to ${endDate}`, { source: "FRED" });
    return obs;
  });
  return { obs: rec.value, url, retrievedAt: rec.retrievedAt, cached: rec.cached };
}

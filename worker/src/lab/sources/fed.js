// sources/fed.js — Federal Reserve Board website (official, public domain U.S. government works).
//  * FOMC statements: links are taken from the official calendar pages
//    (fomccalendars.htm for recent years, fomchistoricalYYYY.htm for older ones); the latest
//    statement dated strictly before the cutoff is used.
//  * Speeches: the Board's speech index (/json/ne-speeches.json) gives date, title, speaker
//    and link; text is extracted from the official page. Speeches are filtered to dates strictly
//    before the cutoff. Only short deterministic extracts are passed on — no LLM is used here.

import { fetchText, cached, SourceError, addDays } from "./http.js";

const BASE = "https://www.federalreserve.gov";
const DAY = 24 * 3600 * 1000;

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|li|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&#39;|&#039;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#8211;|&ndash;/g, "–").replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// Article body of an official page: from id="article" up to footnotes / page footer.
export function articleText(html) {
  const i = html.indexOf('id="article"');
  if (i < 0) throw new SourceError("Fed page: article body not found", { source: "Federal Reserve" });
  let body = html.slice(i);
  const end = body.search(/id="lastUpdate"|class="lastUpdate"|Last Update:|<footer/i);
  if (end > 0) body = body.slice(0, end);
  return htmlToText(body.replace(/^id="article"[^>]*>/, ""))
    .replace(/^.*?\bShare\b/s, "").replace(/\bWatch Live\b/, "").trim();
}

function words(t, n) { const w = t.split(/\s+/); return w.slice(0, n).join(" ") + (w.length > n ? " …" : ""); }

/* ---------------- statements ---------------- */

export function statementLinks(html) {
  const out = new Map();
  for (const m of String(html).matchAll(/(\/newsevents\/pressreleases\/monetary(\d{4})(\d{2})(\d{2})a\.htm)/g)) {
    out.set(m[1], { date: `${m[2]}-${m[3]}-${m[4]}`, url: BASE + m[1] });
  }
  return [...out.values()];
}

export async function latestStatement(env, cutoff) {
  const year = Number(cutoff.slice(0, 4));
  const pages = [`${BASE}/monetarypolicy/fomccalendars.htm`, `${BASE}/monetarypolicy/fomchistorical${year}.htm`, `${BASE}/monetarypolicy/fomchistorical${year - 1}.htm`];
  let links = [];
  for (const url of pages) {
    try {
      const rec = await cached(env, `fedcal|${url}`, url.includes("historical") ? Infinity : DAY, async () => statementLinks(await fetchText(url, { env, source: "Federal Reserve" })));
      links = links.concat(rec.value);
    } catch (e) { if (e.status !== 404) throw e; } // historical page may not exist for recent years
    const best = links.filter((l) => l.date < cutoff).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (best && best.date.slice(0, 4) >= String(year - 1)) break;
  }
  const best = [...new Map(links.map((l) => [l.url, l])).values()].filter((l) => l.date < cutoff).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!best) return null;
  const rec = await cached(env, `fedstmt|${best.url}`, Infinity, async () => {
    const text = articleText(await fetchText(best.url, { env, source: "Federal Reserve" }));
    if (text.length < 200) throw new SourceError("Fed statement: extracted text too short", { source: "Federal Reserve", url: best.url });
    return text;
  });
  const full = rec.value.replace(/^.*?For (immediate )?release at [^\n]*\n?/is, "").trim();
  const decision = full.split("\n").find((p) => /federal funds rate|target range/i.test(p)) || "";
  return { date: best.date, url: best.url, title: `FOMC statement, ${best.date}`, text: full.slice(0, 6000), decisionParagraph: words(decision, 90), retrievedAt: rec.retrievedAt };
}

/* ---------------- speeches ---------------- */

const POLICY_WORDS = /inflation|labor market|employment|monetary policy|interest rate|federal funds|policy rate|outlook|price stability/i;

export function parseSpeechIndex(text) {
  let arr;
  try { arr = JSON.parse(String(text).replace(/^﻿/, "")); } catch { throw new SourceError("Fed speech index: not valid JSON", { source: "Federal Reserve" }); }
  if (!Array.isArray(arr)) throw new SourceError("Fed speech index: unexpected format", { source: "Federal Reserve" });
  const out = new Map();
  for (const x of arr) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(x?.d || "");
    if (!m || !x.l || !x.s) continue; // skip incomplete entries rather than guessing
    const date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (!out.has(x.l)) out.set(x.l, { date, title: htmlToText(x.t || ""), speaker: htmlToText(x.s), venue: htmlToText(x.lo || ""), url: BASE + x.l });
  }
  return [...out.values()];
}

export async function recentSpeeches(env, cutoff, { windowDays = 45, max = 5 } = {}) {
  const idx = await cached(env, "fedspeechindex", DAY, async () => parseSpeechIndex(await fetchText(`${BASE}/json/ne-speeches.json`, { env, source: "Federal Reserve" })));
  const from = addDays(cutoff, -windowDays);
  const picks = idx.value.filter((s) => s.date < cutoff && s.date >= from).sort((a, b) => b.date.localeCompare(a.date)).slice(0, max);
  const out = [];
  for (const s of picks) {
    try {
      const rec = await cached(env, `fedspeech|${s.url}`, Infinity, async () => articleText(await fetchText(s.url, { env, source: "Federal Reserve" })));
      const paras = rec.value.split("\n").map((p) => p.trim()).filter((p) => p.split(/\s+/).length > 25);
      const policy = paras.filter((p) => POLICY_WORDS.test(p)).slice(0, 2);
      out.push({ ...s, extract: words((policy.length ? policy : paras.slice(0, 1)).join(" "), 110), textAvailable: true, retrievedAt: rec.retrievedAt });
    } catch (e) {
      out.push({ ...s, extract: "", textAvailable: false, error: e.message, retrievedAt: idx.retrievedAt });
    }
  }
  return { speeches: out, indexRetrievedAt: idx.retrievedAt, windowDays };
}

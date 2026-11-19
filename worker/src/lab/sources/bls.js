// sources/bls.js — U.S. Bureau of Labor Statistics Public Data API.
//  * v2 with BLS_API_KEY (free registration: 500 queries/day, 20 years) or keyless v1
//    (25 queries/day, 10 years). One POST fetches all labor series for a snapshot.
//  * The BLS API returns CURRENT (revised) values and no release dates. Release timing is
//    approximated conservatively: month m counts as published only if month m+1 is entirely
//    before the cutoff month (the Employment Situation is released early in month m+1).

import { fetchText, cached, SourceError } from "./http.js";

export const BLS_SERIES = {
  LNS14000000: { key: "unemployment", label: "Unemployment rate", unit: "%" },
  CES0000000001: { key: "payrolls", label: "Nonfarm payrolls", unit: "thousands" },
  LNS11300000: { key: "participation", label: "Labor force participation rate", unit: "%" },
  CES0500000003: { key: "hourlyEarnings", label: "Average hourly earnings, private", unit: "$" },
  LNS12300000: { key: "employmentPopRatio", label: "Employment-population ratio", unit: "%" },
};

export function parseBls(json) {
  if (!json || typeof json !== "object") throw new SourceError("BLS: malformed response", { source: "BLS" });
  if (json.status !== "REQUEST_SUCCEEDED") {
    const msg = (json.message || []).join(" ").slice(0, 200) || json.status || "unknown error";
    const limited = /threshold|limit|daily/i.test(msg);
    throw new SourceError(`BLS: ${limited ? "rate limit reached — " : ""}${msg}`, { source: "BLS", status: limited ? 429 : null });
  }
  const out = {};
  for (const s of json.Results?.series || []) {
    out[s.seriesID] = (s.data || [])
      .filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period) && Number.isFinite(Number(d.value)))
      .map((d) => ({ date: `${d.year}-${d.period.slice(1)}-01`, value: Number(d.value), preliminary: (d.footnotes || []).some((f) => /preliminary/i.test(f?.text || "")) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

export async function blsLabor(env, cutoff) {
  const endYear = Number(cutoff.slice(0, 4)), startYear = endYear - 2;
  const v2 = !!env.BLS_API_KEY;
  const url = `https://api.bls.gov/publicAPI/${v2 ? "v2" : "v1"}/timeseries/data/`;
  const body = { seriesid: Object.keys(BLS_SERIES), startyear: String(startYear), endyear: String(endYear), ...(v2 ? { registrationkey: env.BLS_API_KEY } : {}) };
  const today = new Date().toISOString().slice(0, 10);
  const rec = await cached(env, `bls|${startYear}-${endYear}|${cutoff < today ? cutoff.slice(0, 7) : today}`, 24 * 3600 * 1000, async () => {
    const text = await fetchText(url, { env, source: "BLS", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
    let json; try { json = JSON.parse(text); } catch { throw new SourceError("BLS: response was not JSON", { source: "BLS" }); }
    return parseBls(json);
  });
  const cutoffMonth = cutoff.slice(0, 7);
  const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
  const eligible = Object.fromEntries(Object.entries(rec.value).map(([id, obs]) => [id, obs.filter((o) => nextMonth(o.date.slice(0, 7)) < cutoffMonth)]));
  return { series: eligible, api: v2 ? "v2" : "v1 (keyless)", url, retrievedAt: rec.retrievedAt, cached: rec.cached };
}

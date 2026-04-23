// worker.js v2 — Enhanced: yield curve, consumer sentiment, recession probability,
// stagflation + tariff_shock scenarios, AI narrative with GPT fallback, mean reversion

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/meta") {
        return json({
          ok: true, service: "us-macro-dashboard", version: "2.0",
          endpoints: ["/forecast"],
          ai_narrative: !!env.OPENAI_API_KEY
        }, 200);
      }

      if (url.pathname === "/forecast" && request.method === "POST") {
        const body = await request.json();

        const year          = Number(body.year || 2026);
        const horizonMonths = clampInt(body.horizonMonths ?? 12, 1, 60);
        const windowMonths  = clampInt(body.windowMonths ?? 36, 12, 240);
        const question      = String(body.question || "forecast US economy");
        const scenario      = String(body.scenario || "baseline");
        const shocks        = body.shocks || {};
        const nfciShock     = clampNum(shocks.nfci ?? 0, -2, 2);
        const ffShock       = clampNum(shocks.ff ?? 0, -4, 4);

        const updated = await latestCommonDate(env);

        const nfciMonthly      = await fetchNFCIMonthlyAverages(env);
        const nfciLatestGlobal = nfciMonthly.length ? nfciMonthly[nfciMonthly.length - 1].value : 0;

        const [cpi, unrate, fedfunds, indpro, gdp, nfci, t10y2y, umcsent] = await Promise.all([
          buildCPIYoY(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
          buildMonthlyLevel(env, "UNRATE", windowMonths, horizonMonths, {
            seriesKey: "UNRATE", scenario, nfciShock, ffShock, nfciLatestGlobal, anchor: null
          }),
          buildMonthlyLevel(env, "FEDFUNDS", windowMonths, horizonMonths, {
            seriesKey: "FEDFUNDS", scenario, nfciShock, ffShock, nfciLatestGlobal, anchor: null
          }),
          buildMonthlyLevel(env, "INDPRO", windowMonths, horizonMonths, {
            seriesKey: "INDPRO", scenario, nfciShock, ffShock, nfciLatestGlobal, anchor: null
          }),
          buildGDPYoYMonthly(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
          buildNFCIMonthly(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock }),
          buildT10Y2YMonthly(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
          buildConsumerSentiment(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
        ]);

        const recessionProbability = computeRecessionProbability({ nfci, unrate, t10y2y, cpi });

        const seriesData = { cpi, unrate, fedfunds, indpro, gdp, nfci, t10y2y, umcsent };

        let narrative = null;
        if (env.OPENAI_API_KEY) {
          narrative = await generateAINarrative(env, {
            updated, year, horizonMonths, windowMonths, question,
            scenario, nfciShock, ffShock, series: seriesData, recessionProbability
          }).catch(() => null);
        }

        if (!narrative) {
          narrative = makeNarrativeFromForecasts({
            updated, year, horizonMonths, windowMonths, question,
            scenario, nfciShock, ffShock, series: seriesData, recessionProbability
          });
        }

        return json({
          updated,
          params: { horizonMonths, windowMonths, year, scenario, shocks: { nfci: nfciShock, ff: ffShock } },
          recessionProbability,
          aiNarrative: !!env.OPENAI_API_KEY,
          series: {
            cpi,
            unemployment: unrate,
            fedFunds: fedfunds,
            industrialProduction: indpro,
            gdp,
            fci: nfci,
            yieldCurve: t10y2y,
            consumerSentiment: umcsent,
          },
          narrative
        }, 200);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  }
};

/* ========================= HTTP HELPERS ========================= */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function clampInt(x, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(x))));
}

function clampNum(x, min, max) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

/* ========================= FRED FETCH ========================= */
async function fredSeriesObservations(env, seriesId) {
  const key = env.FRED_API_KEY;
  if (!key) throw new Error("Missing env.FRED_API_KEY");

  const u = new URL("https://api.stlouisfed.org/fred/series/observations");
  u.searchParams.set("series_id", seriesId);
  u.searchParams.set("api_key", key);
  u.searchParams.set("file_type", "json");

  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);

  const data = await res.json();
  return (data.observations || [])
    .map(o => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
    .filter(o => o.value !== null && !Number.isNaN(o.value));
}

async function latestCommonDate(env) {
  const obs = await fredSeriesObservations(env, "CPIAUCSL");
  return obs[obs.length - 1]?.date || "—";
}

/* ========================= DATE UTILS ========================= */
function toMonthStart(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}

function addMonths(yyyyMm01, n) {
  const [y, m] = yyyyMm01.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthIndex(yyyyMm01) {
  return Math.max(1, Math.min(12, Number(yyyyMm01.slice(5, 7)))) - 1;
}

function buildMonthlyLabels(lastMonth01, historyMonths, horizonMonths) {
  const total = historyMonths + horizonMonths;
  const start = addMonths(lastMonth01, -(historyMonths - 1));
  return Array.from({ length: total }, (_, i) => addMonths(start, i));
}

/* ========================= SCENARIO CONFIG ========================= */
function scenarioConfig(scenario) {
  switch (scenario) {
    case "soft_landing":      return { driftMult: 0.85, noiseMult: 0.9  };
    case "credit_tightening": return { driftMult: 0.70, noiseMult: 1.25 };
    case "reacceleration":    return { driftMult: 1.15, noiseMult: 1.10 };
    case "stagflation":       return { driftMult: 0.60, noiseMult: 1.40 };
    case "tariff_shock":      return { driftMult: 0.75, noiseMult: 1.30 };
    case "baseline":
    default:                  return { driftMult: 1.00, noiseMult: 1.00 };
  }
}

function seriesDriftTilt(seriesKey, scenario) {
  const map = {
    credit_tightening: { UNRATE: 1.25, INDPRO: 0.75, GDP: 0.80, CPI: 0.90, NFCI: 1.10, T10Y2Y: 0.80, UMCSENT: 0.75, FEDFUNDS: 1.05 },
    reacceleration:    { UNRATE: 0.85, INDPRO: 1.15, GDP: 1.15, CPI: 1.10, NFCI: 0.95, T10Y2Y: 1.15, UMCSENT: 1.15, FEDFUNDS: 1.10 },
    soft_landing:      { UNRATE: 0.90, INDPRO: 0.95, GDP: 0.95, CPI: 0.90, NFCI: 0.95, T10Y2Y: 1.10, UMCSENT: 1.05, FEDFUNDS: 0.90 },
    stagflation:       { UNRATE: 1.30, INDPRO: 0.70, GDP: 0.60, CPI: 1.40, NFCI: 1.20, T10Y2Y: 0.75, UMCSENT: 0.60, FEDFUNDS: 1.20 },
    tariff_shock:      { UNRATE: 1.20, INDPRO: 0.80, GDP: 0.70, CPI: 1.30, NFCI: 1.15, T10Y2Y: 0.70, UMCSENT: 0.70, FEDFUNDS: 1.10 },
  };
  return map[scenario]?.[seriesKey] ?? 1.0;
}

function shockToDrift(seriesKey, nfciShock, ffShock) {
  const n = Number(nfciShock) || 0;
  const f = Number(ffShock) || 0;
  switch (seriesKey) {
    case "UNRATE":   return  0.040 * n + 0.015 * f;
    case "INDPRO":   return -0.250 * n - 0.080 * f;
    case "GDP":      return -0.100 * n - 0.050 * f;
    case "CPI":      return -0.060 * n - 0.030 * f;
    case "NFCI":     return  0.080 * n + 0.020 * f;
    case "FEDFUNDS": return  0.020 * f;
    case "T10Y2Y":   return -0.040 * n - 0.015 * f;
    case "UMCSENT":  return -2.500 * n - 1.000 * f;
    default:         return 0;
  }
}

function softClamp(seriesKey, x) {
  if (!Number.isFinite(x)) return 0;
  switch (seriesKey) {
    case "UNRATE":   return Math.max(2,   Math.min(15,  x));
    case "FEDFUNDS": return Math.max(0,   Math.min(10,  x));
    case "INDPRO":   return Math.max(40,  Math.min(140, x));
    case "CPI":      return Math.max(-2,  Math.min(15,  x));
    case "GDP":      return Math.max(-8,  Math.min(10,  x));
    case "NFCI":     return Math.max(-2.5,Math.min(3.5, x));
    case "T10Y2Y":   return Math.max(-3,  Math.min(4,   x));
    case "UMCSENT":  return Math.max(40,  Math.min(120, x));
    default:         return x;
  }
}

// Long-run mean-reversion targets (where the series gravitates over time)
const MEAN_REVERSION = {
  CPI:      { target: 2.5,  speed: 0.04 },
  UNRATE:   { target: 4.2,  speed: 0.03 },
  NFCI:     { target: 0.0,  speed: 0.06 },
  FEDFUNDS: { target: 3.5,  speed: 0.04 },
  GDP:      { target: 2.0,  speed: 0.05 },
  T10Y2Y:   { target: 1.0,  speed: 0.05 },
  UMCSENT:  { target: 82.0, speed: 0.04 },
};

function meanRevForce(seriesKey, level) {
  const cfg = MEAN_REVERSION[seriesKey];
  if (!cfg) return 0;
  return cfg.speed * (cfg.target - level);
}

/* ========================= MATH UTILS ========================= */
function computeDiffs(values) {
  const d = [];
  for (let i = 1; i < values.length; i++) d.push(values[i] - values[i - 1]);
  return d;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos  = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] === undefined) return sortedArr[base];
  return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
}

function buildSeasonalityFromDiffs(values, labels) {
  const sums = Array(12).fill(0), counts = Array(12).fill(0);
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const mo = monthIndex(labels[i]);
    if (Number.isFinite(d)) { sums[mo] += d; counts[mo]++; }
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}

function sample(arr, rand) {
  return arr.length ? arr[Math.floor(rand() * arr.length)] : 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function smooth(arr, alpha) {
  if (!arr.length) return arr;
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(alpha * arr[i] + (1 - alpha) * out[i - 1]);
  return out;
}

function round2(x) {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return v;
  }
  return null;
}

/* ========================= MONTE CARLO ========================= */
function forecastMonteCarlo({
  historyValues, historyLabels, horizonMonths,
  scenario, nfciLatest, seriesKey, nfciShock, ffShock
}) {
  const { driftMult, noiseMult } = scenarioConfig(scenario);

  const diffs  = computeDiffs(historyValues);
  const recent = diffs.slice(Math.max(0, diffs.length - 12));
  let   drift  = mean(recent);

  const seas      = buildSeasonalityFromDiffs(historyValues, historyLabels);
  const residuals = [];
  for (let i = 1; i < historyValues.length; i++) {
    const d  = historyValues[i] - historyValues[i - 1];
    const mo = monthIndex(historyLabels[i]);
    const r  = d - drift - seas[mo];
    if (Number.isFinite(r)) residuals.push(r);
  }

  const baseVol    = std(residuals);
  const nfciScale  = Number.isFinite(nfciLatest) ? Math.max(0, nfciLatest) : 0;
  const stateNoise = 1 + Math.min(0.8, 0.45 * nfciScale);
  const volMult    = noiseMult * stateNoise;

  drift += shockToDrift(seriesKey, nfciShock, ffShock);
  drift *= driftMult * seriesDriftTilt(seriesKey, scenario);

  const N = 500;
  const H = horizonMonths;
  const endValsByH = Array.from({ length: H }, () => []);
  const pathMean   = Array(H).fill(0);

  const seed = hashSeed(
    `${seriesKey}|${scenario}|${historyValues.length}|${historyValues[historyValues.length - 1]}|${nfciLatest}|${nfciShock}|${ffShock}|${H}`
  );
  const rand = mulberry32(seed);

  for (let s = 0; s < N; s++) {
    let level = historyValues[historyValues.length - 1];
    for (let h = 1; h <= H; h++) {
      const futureLabel = addMonths(historyLabels[historyLabels.length - 1], h);
      const mo = monthIndex(futureLabel);

      const shock = sample(residuals, rand);
      const rev   = meanRevForce(seriesKey, level);
      const delta = drift + seas[mo] + shock * volMult + rev;

      level = softClamp(seriesKey, level + delta);
      endValsByH[h - 1].push(level);
      pathMean[h - 1] += level;
    }
  }

  for (let i = 0; i < H; i++) pathMean[i] /= N;

  const p10 = [], p90 = [];
  for (let i = 0; i < H; i++) {
    const arr = endValsByH[i].slice().sort((a, b) => a - b);
    p10.push(round2(quantile(arr, 0.1)));
    p90.push(round2(quantile(arr, 0.9)));
  }

  return {
    mean: smooth(pathMean, 0.25).map(round2),
    p10, p90,
    diagnostics: { drift: round2(drift), baseVol: round2(baseVol), volMult: round2(volMult) }
  };
}

/* ========================= SERIES BUILDERS ========================= */
function padSeries(labels, windowMonths, horizonMonths, historyWindow, fc, anchor) {
  const latest = lastNonNull(historyWindow);
  return {
    labels,
    history:       historyWindow.concat(Array(horizonMonths).fill(null)),
    forecast:      Array(windowMonths).fill(null).concat(fc.mean),
    p10_forecast:  Array(windowMonths).fill(null).concat(fc.p10),
    p90_forecast:  Array(windowMonths).fill(null).concat(fc.p90),
    anchor:        anchor ?? null,
    latest:        latest != null ? round2(latest) : null,
    diagnostics:   fc.diagnostics
  };
}

function toMonthlyAligned(obs) {
  const map = new Map();
  for (const o of obs) {
    const m = toMonthStart(o.date);
    const v = Number(o.value);
    if (Number.isFinite(v)) map.set(m, v);
  }
  return Array.from(map.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function monthlyAverageFromHighFreq(obs) {
  const bucket = new Map();
  for (const o of obs) {
    const m = toMonthStart(o.date);
    const v = Number(o.value);
    if (!Number.isFinite(v)) continue;
    if (!bucket.has(m)) bucket.set(m, { sum: 0, n: 0 });
    const b = bucket.get(m);
    b.sum += v; b.n++;
  }
  return Array.from(bucket.entries())
    .map(([date, b]) => ({ date, value: b.n ? b.sum / b.n : null }))
    .filter(d => d.value !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function computeYoYFromLevel(monthlyObs) {
  const out = [], vals = monthlyObs.map(o => o.value);
  for (let i = 12; i < monthlyObs.length; i++) {
    const cur = vals[i], prev = vals[i - 12];
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) continue;
    out.push({ date: monthlyObs[i].date, value: (cur / prev - 1) * 100 });
  }
  return out;
}

function quarterlyToMonthlyStepFill(qObs) {
  const out = [];
  for (const o of qObs) {
    const m0 = toMonthStart(o.date);
    const v  = Number(o.value);
    if (!Number.isFinite(v)) continue;
    out.push({ date: addMonths(m0, -2), value: v });
    out.push({ date: addMonths(m0, -1), value: v });
    out.push({ date: m0, value: v });
  }
  const map = new Map();
  for (const d of out) map.set(d.date, d.value);
  return Array.from(map.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function extractHistoryTail(monthlyObs, months) {
  const tail = monthlyObs.slice(Math.max(0, monthlyObs.length - months));
  return { labels: tail.map(d => d.date), values: tail.map(d => d.value) };
}

async function fetchNFCIMonthlyAverages(env) {
  return monthlyAverageFromHighFreq(await fredSeriesObservations(env, "NFCI"));
}

async function buildMonthlyLevel(env, seriesId, windowMonths, horizonMonths, opts) {
  const scenario       = opts?.scenario || "baseline";
  const nfciShock      = Number(opts?.nfciShock) || 0;
  const ffShock        = Number(opts?.ffShock) || 0;
  const nfciLatest     = Number(opts?.nfciLatestGlobal) || 0;
  const seriesKey      = opts?.seriesKey || seriesId;
  const anchor         = opts?.anchor ?? null;

  const raw     = await fredSeriesObservations(env, seriesId);
  const monthly = toMonthlyAligned(raw);

  if (monthly.length < windowMonths + 2) throw new Error(`Not enough data for ${seriesId}`);

  const tail        = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map      = new Map(monthly.map(o => [o.date, o.value]));
  const histRaw  = labels.slice(0, windowMonths).map(d => (map.has(d) ? map.get(d) : null));
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey, nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, anchor);
}

async function buildNFCIMonthly(env, windowMonths, horizonMonths, opts) {
  const scenario  = opts?.scenario || "baseline";
  const nfciShock = Number(opts?.nfciShock) || 0;
  const ffShock   = Number(opts?.ffShock) || 0;

  const monthly = await fetchNFCIMonthlyAverages(env);
  if (monthly.length < windowMonths + 2) throw new Error(`Not enough data for NFCI`);

  const tail        = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map       = new Map(monthly.map(o => [o.date, o.value]));
  const histRaw   = labels.slice(0, windowMonths).map(d => map.has(d) ? map.get(d) : null);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));
  const nfciLatest = histClean.length ? histClean[histClean.length - 1] : 0;

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey: "NFCI", nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, 0);
}

async function buildCPIYoY(env, windowMonths, horizonMonths, opts) {
  const scenario       = opts?.scenario || "baseline";
  const nfciShock      = Number(opts?.nfciShock) || 0;
  const ffShock        = Number(opts?.ffShock) || 0;
  const nfciLatest     = Number(opts?.nfciLatestGlobal) || 0;

  const raw         = await fredSeriesObservations(env, "CPIAUCSL");
  const monthlyLvl  = toMonthlyAligned(raw);
  const monthlyYoY  = computeYoYFromLevel(monthlyLvl);

  if (monthlyYoY.length < windowMonths + 2) throw new Error(`Not enough CPI YoY history`);

  const tail        = extractHistoryTail(monthlyYoY, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map       = new Map(monthlyYoY.map(o => [o.date, o.value]));
  const histRaw   = labels.slice(0, windowMonths).map(d => map.has(d) ? map.get(d) : null);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey: "CPI", nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, 2);
}

async function buildGDPYoYMonthly(env, windowMonths, horizonMonths, opts) {
  const scenario   = opts?.scenario || "baseline";
  const nfciShock  = Number(opts?.nfciShock) || 0;
  const ffShock    = Number(opts?.ffShock) || 0;
  const nfciLatest = Number(opts?.nfciLatestGlobal) || 0;

  const rawQ       = await fredSeriesObservations(env, "GDPC1");
  const qAsMonthly = quarterlyToMonthlyStepFill(rawQ);
  const monthlyYoY = computeYoYFromLevel(qAsMonthly);

  if (monthlyYoY.length < windowMonths + 2) throw new Error(`Not enough GDP YoY monthly history`);

  const tail        = extractHistoryTail(monthlyYoY, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map       = new Map(monthlyYoY.map(o => [o.date, o.value]));
  const histRaw   = labels.slice(0, windowMonths).map(d => map.has(d) ? map.get(d) : null);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey: "GDP", nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, null);
}

async function buildT10Y2YMonthly(env, windowMonths, horizonMonths, opts) {
  const scenario   = opts?.scenario || "baseline";
  const nfciShock  = Number(opts?.nfciShock) || 0;
  const ffShock    = Number(opts?.ffShock) || 0;
  const nfciLatest = Number(opts?.nfciLatestGlobal) || 0;

  // T10Y2Y is a daily series — average to monthly
  const raw     = await fredSeriesObservations(env, "T10Y2Y");
  const monthly = monthlyAverageFromHighFreq(raw);

  if (monthly.length < windowMonths + 2) throw new Error(`Not enough T10Y2Y data`);

  const tail        = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map       = new Map(monthly.map(o => [o.date, o.value]));
  const histRaw   = labels.slice(0, windowMonths).map(d => map.has(d) ? map.get(d) : null);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey: "T10Y2Y", nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, 0);
}

async function buildConsumerSentiment(env, windowMonths, horizonMonths, opts) {
  const scenario   = opts?.scenario || "baseline";
  const nfciShock  = Number(opts?.nfciShock) || 0;
  const ffShock    = Number(opts?.ffShock) || 0;
  const nfciLatest = Number(opts?.nfciLatestGlobal) || 0;

  const raw     = await fredSeriesObservations(env, "UMCSENT");
  const monthly = toMonthlyAligned(raw);

  if (monthly.length < windowMonths + 2) throw new Error(`Not enough UMCSENT data`);

  const tail        = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels      = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map       = new Map(monthly.map(o => [o.date, o.value]));
  const histRaw   = labels.slice(0, windowMonths).map(d => map.has(d) ? map.get(d) : null);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths, scenario, nfciLatest, seriesKey: "UMCSENT", nfciShock, ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => v == null ? null : round2(v)), fc, null);
}

/* ========================= RECESSION PROBABILITY ========================= */
function computeRecessionProbability({ nfci, unrate, t10y2y, cpi }) {
  let prob = 8;

  const t10y2yLatest = t10y2y?.latest;
  const nfciLatest   = nfci?.latest;
  const cpiLatest    = cpi?.latest;

  // Yield curve
  if (t10y2yLatest !== null && t10y2yLatest !== undefined) {
    if      (t10y2yLatest < -1.0) prob += 40;
    else if (t10y2yLatest < -0.5) prob += 30;
    else if (t10y2yLatest < 0.0)  prob += 18;
    else if (t10y2yLatest < 0.5)  prob +=  5;
  }

  // NFCI (tighter = worse)
  if (nfciLatest !== null && nfciLatest !== undefined) {
    if      (nfciLatest > 1.5) prob += 30;
    else if (nfciLatest > 1.0) prob += 20;
    else if (nfciLatest > 0.5) prob += 12;
    else if (nfciLatest > 0.2) prob +=  5;
  }

  // Sahm rule approximation from history
  const unrateHistory = (unrate?.history || []).filter(v => v !== null && Number.isFinite(v));
  if (unrateHistory.length >= 13) {
    const recent3     = unrateHistory.slice(-3);
    const prior12min  = Math.min(...unrateHistory.slice(-13, -3));
    const recent3Avg  = mean(recent3);
    const sahmDiff    = recent3Avg - prior12min;
    if      (sahmDiff > 0.5) prob += 22;
    else if (sahmDiff > 0.3) prob += 12;
    else if (sahmDiff > 0.1) prob +=  5;
  }

  // Stagflation signal: high inflation + sub-trend growth
  if (cpiLatest !== null && cpiLatest > 4.5) prob += 8;

  return Math.min(92, Math.max(3, Math.round(prob)));
}

/* ========================= AI NARRATIVE ========================= */
function fmt(x, d = 2) {
  if (x == null || !Number.isFinite(Number(x))) return "N/A";
  return Number(x).toFixed(d);
}

function buildNarrativePrompt({ updated, year, horizonMonths, scenario, nfciShock, ffShock, series, recessionProbability, question }) {
  const { cpi, unrate, fedfunds, indpro, gdp, nfci, t10y2y, umcsent } = series;

  const endVal = (s) => lastNonNull(s?.forecast || []);
  const p10Val = (s) => lastNonNull(s?.p10_forecast || []);
  const p90Val = (s) => lastNonNull(s?.p90_forecast || []);

  return `You are a senior macroeconomic analyst writing a professional US economic outlook for ${year}.

CURRENT DATA (FRED, as of ${updated}):
| Indicator | Latest | ${horizonMonths}m Forecast | P10 | P90 |
|---|---|---|---|---|
| CPI YoY | ${fmt(cpi.latest)}% | ${fmt(endVal(cpi))}% | ${fmt(p10Val(cpi))}% | ${fmt(p90Val(cpi))}% |
| Unemployment | ${fmt(unrate.latest)}% | ${fmt(endVal(unrate))}% | ${fmt(p10Val(unrate))}% | ${fmt(p90Val(unrate))}% |
| Fed Funds | ${fmt(fedfunds.latest)}% | ${fmt(endVal(fedfunds))}% | — | — |
| Real GDP YoY | ${fmt(gdp.latest)}% | ${fmt(endVal(gdp))}% | ${fmt(p10Val(gdp))}% | ${fmt(p90Val(gdp))}% |
| NFCI | ${fmt(nfci.latest)} | ${fmt(endVal(nfci))} | — | — |
| 10Y-2Y Spread | ${fmt(t10y2y.latest)}pp | ${fmt(endVal(t10y2y))}pp | — | — |
| Consumer Sentiment | ${fmt(umcsent.latest)} | ${fmt(endVal(umcsent))} | — | — |

SCENARIO: ${scenario.replace(/_/g, " ")}
POLICY SHOCKS: ΔNFCI ${nfciShock >= 0 ? "+" : ""}${fmt(nfciShock)}, ΔFF ${ffShock >= 0 ? "+" : ""}${fmt(ffShock)}pp
MODEL RECESSION PROBABILITY (12-month): ${recessionProbability}%
CLIENT QUESTION: "${question}"

Write a professional economic outlook in clean markdown (under 400 words). Structure:
## Executive Summary
- (3 sharp bullet points — the most important insights)

## Economic Outlook
(Analyze current conditions and what the forecast implies for growth, inflation, and employment)

## Key Risks
(Top 3 risks with a sentence each)

## Fed Policy Outlook
(What the Fed is likely to do given this data)

---
*Analysis based on FRED data via Monte Carlo simulation. Not financial advice.*`;
}

async function generateAINarrative(env, context) {
  const prompt = buildNarrativePrompt(context);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a senior macroeconomist at a top investment bank. Write precise, data-driven economic analysis in clean markdown. Be specific about numbers and confident in your assessments."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 700,
      temperature: 0.25
    })
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

/* ========================= TEMPLATE NARRATIVE (markdown) ========================= */
function slopeLabel(a, b) {
  const d = b - a;
  if (!Number.isFinite(d)) return "mixed";
  if (Math.abs(d) < 0.05) return "flat";
  return d > 0 ? "rising" : "falling";
}

function summarize(name, key, s) {
  const f  = s.forecast || [];
  const p10 = s.p10_forecast || [];
  const p90 = s.p90_forecast || [];
  const latest  = s.latest ?? lastNonNull(s.history || []);
  const endMean = lastNonNull(f);
  const endP10  = lastNonNull(p10);
  const endP90  = lastNonNull(p90);
  const delta   = (endMean != null && latest != null) ? endMean - latest : null;
  const band    = (endP90 != null && endP10 != null) ? endP90 - endP10 : null;

  return { name, key, latest, endMean, endP10, endP90, delta, band, trend: latest != null && endMean != null ? slopeLabel(latest, endMean) : "mixed" };
}

function makeNarrativeFromForecasts(payload) {
  const { updated, year, horizonMonths, windowMonths, scenario, nfciShock, ffShock, question, series, recessionProbability } = payload;

  const rows = [
    summarize("Inflation (CPI YoY)", "cpi",   series.cpi),
    summarize("Unemployment",         "u",     series.unrate),
    summarize("Fed Funds",            "ff",    series.fedfunds),
    summarize("Real GDP (YoY)",       "gdp",   series.gdp),
    summarize("10Y-2Y Spread",        "t10y2y",series.t10y2y),
    summarize("Financial Cond (NFCI)","fci",   series.nfci),
    summarize("Consumer Sentiment",   "sent",  series.umcsent),
  ];

  const pctKeys = new Set(["cpi", "u", "ff", "gdp", "t10y2y"]);

  const line = (r) => {
    const suf   = pctKeys.has(r.key) ? "%" : "";
    const drift = r.delta == null ? "—" :
      Math.abs(r.delta) < 0.05 ? "flat" :
      r.delta > 0 ? `↑ +${fmt(r.delta, 2)}${suf}` : `↓ ${fmt(r.delta, 2)}${suf}`;
    const conf = r.band == null ? "" :
      r.band > 3 ? " (wide uncertainty)" :
      r.band > 1.5 ? " (moderate uncertainty)" : " (tighter band)";
    const p10str = r.endP10 != null ? fmt(r.endP10, 2) : "—";
    const p90str = r.endP90 != null ? fmt(r.endP90, 2) : "—";
    return `| ${r.name} | ${fmt(r.latest, 2)}${suf} | ${fmt(r.endMean, 2)}${suf} | ${drift}${conf} | ${p10str}–${p90str}${suf} |`;
  };

  const recDesc = recessionProbability < 20 ? "Low" :
                  recessionProbability < 40 ? "Moderate" :
                  recessionProbability < 60 ? "Elevated" : "High";

  const t10y2yLatest = series.t10y2y?.latest;
  const yieldNote = t10y2yLatest != null ?
    (t10y2yLatest < 0 ? `The yield curve remains **inverted** (${fmt(t10y2yLatest)}pp), a historically reliable recession signal.` :
     t10y2yLatest < 0.5 ? `The yield curve is near flat (${fmt(t10y2yLatest)}pp), watching for re-inversion.` :
     `The yield curve has a positive slope (${fmt(t10y2yLatest)}pp), suggesting limited near-term recession risk from this indicator.`) : "";

  const cpiLatest = series.cpi?.latest;
  const inflNote = cpiLatest != null ?
    (cpiLatest > 4 ? "Inflation remains well above the Fed's 2% target, limiting policy room." :
     cpiLatest > 2.5 ? "Inflation is above target but trending lower." :
     "Inflation is near or at target.") : "";

  return `## US Economy ${year} Outlook
*Scenario: **${scenario.replace(/_/g, " ")}** · Horizon: ${horizonMonths}m · Window: ${windowMonths}m · Updated: ${updated}*
*Question: "${question}"*

---

## Executive Summary
- **Recession probability (12m):** ${recessionProbability}% — ${recDesc} risk
- ${inflNote}
- ${yieldNote}

---

## Forecast Readout (Monte Carlo, P10–P90 range)

| Indicator | Latest | ${horizonMonths}m Forecast | Direction | P10–P90 |
|---|---|---|---|---|
${rows.map(line).join("\n")}

---

## Key Risks
- **Yield curve & credit:** ${t10y2yLatest != null && t10y2yLatest < 0 ? "Inverted curve historically precedes downturns with a 6–18m lag." : "Monitor for re-inversion if the Fed holds rates higher."}
- **Inflation persistence:** If CPI stops cooling while unemployment rises, the Fed faces a stagflation dilemma.
- **Financial conditions:** A sustained NFCI move above 0.5 would tighten credit and weigh on growth.

## Policy Shocks Applied
${nfciShock !== 0 || ffShock !== 0
  ? `ΔNFCI ${nfciShock >= 0 ? "+" : ""}${fmt(nfciShock)}, ΔFF ${ffShock >= 0 ? "+" : ""}${fmt(ffShock)}pp. These shift drift in all series accordingly.`
  : "None — running on historical drift + scenario multipliers only."}

---
*Data: FRED via Monte Carlo simulation (N=500 paths). Not financial advice.*`;
}

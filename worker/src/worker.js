// worker.js (Cloudflare Worker)
// Compatible with your current frontend app.js (expects: history/forecast padded + p10_forecast/p90_forecast, narrative as STRING)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/meta") {
        return json({ ok: true, service: "us-macro-dashboard", endpoints: ["/forecast"] }, 200);
      }

      if (url.pathname === "/forecast" && request.method === "POST") {
        const body = await request.json();

        const year = Number(body.year || 2026);
        const horizonMonths = clampInt(body.horizonMonths ?? 12, 1, 60);
        const windowMonths = clampInt(body.windowMonths ?? 36, 12, 240);
        const question = String(body.question || "forecast US economy");

        // Scenario + shocks
        const scenario = String(body.scenario || "baseline");
        const shocks = body.shocks || {};
        const nfciShock = clampNum(shocks.nfci ?? 0, -2, 2);
        const ffShock = clampNum(shocks.ff ?? 0, -4, 4);

        const updated = await latestCommonDate(env);

        // Pull NFCI monthly once (used for scaling uncertainty across series)
        const nfciMonthly = await fetchNFCIMonthlyAverages(env);
        const nfciLatestGlobal = nfciMonthly.length ? nfciMonthly[nfciMonthly.length - 1].value : 0;

        // Build series (monthly aligned + padded arrays)
        const [cpi, unrate, fedfunds, indpro, gdp, nfci] = await Promise.all([
          buildCPIYoY(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
          buildMonthlyLevel(env, "UNRATE", windowMonths, horizonMonths, {
            seriesKey: "UNRATE",
            scenario,
            nfciShock,
            ffShock,
            nfciLatestGlobal,
            anchor: null
          }),
          buildMonthlyLevel(env, "FEDFUNDS", windowMonths, horizonMonths, {
            seriesKey: "FEDFUNDS",
            scenario,
            nfciShock,
            ffShock,
            nfciLatestGlobal,
            anchor: null
          }),
          buildMonthlyLevel(env, "INDPRO", windowMonths, horizonMonths, {
            seriesKey: "INDPRO",
            scenario,
            nfciShock,
            ffShock,
            nfciLatestGlobal,
            anchor: null
          }),
          buildGDPYoYMonthly(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock, nfciLatestGlobal }),
          buildNFCIMonthly(env, windowMonths, horizonMonths, { scenario, nfciShock, ffShock })
        ]);

        // Narrative as STRING (so narrativeText.textContent works)
        const narrative = makeNarrativeFromForecasts({
          updated,
          year,
          horizonMonths,
          windowMonths,
          question,
          scenario,
          nfciShock,
          ffShock,
          series: { cpi, unrate, fedfunds, indpro, gdp, nfci }
        });

        return json(
          {
            updated,
            params: { horizonMonths, windowMonths, year, scenario, shocks: { nfci: nfciShock, ff: ffShock } },
            series: {
              cpi,
              unemployment: unrate,
              fedFunds: fedfunds,
              industrialProduction: indpro,
              gdp,
              fci: nfci
            },
            narrative
          },
          200
        );
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  }
};

/* =========================
   HTTP HELPERS
========================= */
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
  const v = Math.floor(Number(x));
  return Math.max(min, Math.min(max, v));
}

function clampNum(x, min, max) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

/* =========================
   FRED FETCH
========================= */
async function fredSeriesObservations(env, seriesId) {
  const key = env.FRED_API_KEY;
  if (!key) throw new Error("Missing env.FRED_API_KEY");

  const endpoint = "https://api.stlouisfed.org/fred/series/observations";
  const u = new URL(endpoint);
  u.searchParams.set("series_id", seriesId);
  u.searchParams.set("api_key", key);
  u.searchParams.set("file_type", "json");

  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);

  const data = await res.json();
  const obs = (data.observations || [])
    .map(o => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
    .filter(o => o.value !== null && !Number.isNaN(o.value));

  return obs;
}

async function latestCommonDate(env) {
  const obs = await fredSeriesObservations(env, "CPIAUCSL");
  const last = obs[obs.length - 1];
  return last?.date || "—";
}

/* =========================
   MONTHLY DATE UTIL
========================= */
function toMonthStart(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}

function addMonths(yyyyMm01, n) {
  const [y, m] = yyyyMm01.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}-01`;
}

function monthIndex(yyyyMm01) {
  const m = Number(yyyyMm01.slice(5, 7));
  return Math.max(1, Math.min(12, m)) - 1; // 0..11
}

function buildMonthlyLabels(lastMonth01, historyMonths, horizonMonths) {
  const total = historyMonths + horizonMonths;
  const start = addMonths(lastMonth01, -(historyMonths - 1));
  const labels = [];
  for (let i = 0; i < total; i++) labels.push(addMonths(start, i));
  return labels;
}

/* =========================
   REGIME / SCENARIO CONFIG
========================= */
function scenarioConfig(scenario) {
  switch (scenario) {
    case "soft_landing":
      return { driftMult: 0.85, noiseMult: 0.9 };
    case "credit_tightening":
      return { driftMult: 0.7, noiseMult: 1.25 };
    case "reacceleration":
      return { driftMult: 1.15, noiseMult: 1.1 };
    case "baseline":
    default:
      return { driftMult: 1.0, noiseMult: 1.0 };
  }
}

/* =========================
   MONTE CARLO FORECAST (horizon-only arrays)
========================= */
function computeDiffs(values) {
  const diffs = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  return diffs;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const x of arr) s += (x - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] === undefined) return sortedArr[base];
  return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
}

function buildSeasonalityFromDiffs(values, labels) {
  const sums = Array(12).fill(0);
  const counts = Array(12).fill(0);

  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const mo = monthIndex(labels[i]);
    if (Number.isFinite(d)) {
      sums[mo] += d;
      counts[mo] += 1;
    }
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}

function sample(arr, rand) {
  if (!arr.length) return 0;
  return arr[Math.floor(rand() * arr.length)];
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
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function smooth(arr, alpha) {
  if (!arr.length) return arr;
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(alpha * arr[i] + (1 - alpha) * out[i - 1]);
  return out;
}

function round2(x) {
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function seriesDriftTilt(seriesKey, scenario) {
  if (scenario === "credit_tightening") {
    if (seriesKey === "UNRATE") return 1.25;
    if (seriesKey === "INDPRO") return 0.75;
    if (seriesKey === "GDP") return 0.8;
    if (seriesKey === "CPI") return 0.9;
    if (seriesKey === "NFCI") return 1.1;
    return 1.0;
  }
  if (scenario === "reacceleration") {
    if (seriesKey === "UNRATE") return 0.85;
    if (seriesKey === "INDPRO") return 1.15;
    if (seriesKey === "GDP") return 1.15;
    if (seriesKey === "CPI") return 1.1;
    if (seriesKey === "NFCI") return 0.95;
    return 1.0;
  }
  if (scenario === "soft_landing") {
    if (seriesKey === "UNRATE") return 0.9;
    if (seriesKey === "INDPRO") return 0.95;
    if (seriesKey === "GDP") return 0.95;
    if (seriesKey === "CPI") return 0.9;
    if (seriesKey === "NFCI") return 0.95;
    return 1.0;
  }
  return 1.0;
}

function shockToDrift(seriesKey, nfciShock, ffShock) {
  const n = Number(nfciShock) || 0;
  const f = Number(ffShock) || 0;

  switch (seriesKey) {
    case "UNRATE":
      return 0.04 * n + 0.015 * f;
    case "INDPRO":
      return -0.25 * n - 0.08 * f;
    case "GDP":
      return -0.1 * n - 0.05 * f;
    case "CPI":
      return -0.06 * n - 0.03 * f;
    case "NFCI":
      return 0.08 * n + 0.02 * f;
    case "FEDFUNDS":
      // we generally do NOT “forecast” FF via shocks; keep tiny
      return 0.02 * f;
    default:
      return 0;
  }
}

function softClamp(seriesKey, x) {
  if (!Number.isFinite(x)) return 0;

  switch (seriesKey) {
    case "UNRATE":
      return Math.max(2, Math.min(15, x));
    case "FEDFUNDS":
      return Math.max(0, Math.min(10, x));
    case "INDPRO":
      return Math.max(40, Math.min(140, x));
    case "CPI": // YoY %
      return Math.max(-2, Math.min(15, x));
    case "GDP": // YoY %
      return Math.max(-8, Math.min(10, x));
    case "NFCI":
      return Math.max(-2.5, Math.min(3.5, x));
    default:
      return x;
  }
}

function forecastMonteCarlo({
  historyValues,
  historyLabels,
  horizonMonths,
  scenario,
  nfciLatest,
  seriesKey,
  nfciShock,
  ffShock
}) {
  const { driftMult, noiseMult } = scenarioConfig(scenario);

  const vals = historyValues.slice();
  const labels = historyLabels.slice();

  const diffs = computeDiffs(vals);
  const recent = diffs.slice(Math.max(0, diffs.length - 12));
  let drift = mean(recent);

  const seas = buildSeasonalityFromDiffs(vals, labels);

  const residuals = [];
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    const mo = monthIndex(labels[i]);
    const r = d - drift - seas[mo];
    if (Number.isFinite(r)) residuals.push(r);
  }

  const baseVol = std(residuals);

  // state noise driven by NFCI (tight => wider)
  const nfciScale = Number.isFinite(nfciLatest) ? Math.max(0, nfciLatest) : 0;
  const stateNoise = 1 + Math.min(0.8, 0.45 * nfciScale);
  const volMult = noiseMult * stateNoise;

  drift += shockToDrift(seriesKey, nfciShock, ffShock);
  drift *= driftMult * seriesDriftTilt(seriesKey, scenario);

  const N = 400;
  const H = horizonMonths;
  const endValsByH = Array.from({ length: H }, () => []);
  const pathMean = Array(H).fill(0);

  const seed = hashSeed(
    `${seriesKey}|${scenario}|${vals.length}|${vals[vals.length - 1]}|${nfciLatest}|${nfciShock}|${ffShock}|${H}`
  );
  const rand = mulberry32(seed);

  for (let s = 0; s < N; s++) {
    let level = vals[vals.length - 1];
    for (let h = 1; h <= H; h++) {
      const futureLabel = addMonths(labels[labels.length - 1], h);
      const mo = monthIndex(futureLabel);

      const shock = sample(residuals, rand);
      const delta = drift + seas[mo] + shock * volMult;

      level = level + delta;
      level = softClamp(seriesKey, level);

      const idx = h - 1;
      endValsByH[idx].push(level);
      pathMean[idx] += level;
    }
  }

  for (let i = 0; i < H; i++) pathMean[i] = pathMean[i] / N;

  const p10 = [];
  const p90 = [];
  for (let i = 0; i < H; i++) {
    const arr = endValsByH[i].slice().sort((a, b) => a - b);
    p10.push(round2(quantile(arr, 0.1)));
    p90.push(round2(quantile(arr, 0.9)));
  }

  const meanSm = smooth(pathMean, 0.25).map(round2);

  return {
    mean: meanSm,
    p10,
    p90,
    diagnostics: {
      drift: round2(drift),
      baseVol: round2(baseVol),
      volMult: round2(volMult)
    }
  };
}

/* =========================
   SERIES BUILDERS (frontend-compatible shape)
   -> returns:
   { labels, history: padded, forecast: padded, p10_forecast: padded, p90_forecast: padded, anchor, latest }
========================= */
function padSeries(labels, windowMonths, horizonMonths, historyWindow, fc, anchor) {
  const history = historyWindow.concat(Array(horizonMonths).fill(null));
  const forecast = Array(windowMonths).fill(null).concat(fc.mean);
  const p10_forecast = Array(windowMonths).fill(null).concat(fc.p10);
  const p90_forecast = Array(windowMonths).fill(null).concat(fc.p90);

  const latest = lastNonNull(historyWindow);

  return {
    labels,
    history,
    forecast,
    p10_forecast,
    p90_forecast,
    anchor: anchor ?? null,
    latest: latest != null ? round2(latest) : null,
    diagnostics: fc.diagnostics
  };
}

function toMonthlyAligned(obs) {
  const map = new Map();
  for (const o of obs) {
    const m = toMonthStart(o.date);
    const v = Number(o.value);
    if (!Number.isFinite(v)) continue;
    map.set(m, v);
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
    b.sum += v;
    b.n += 1;
  }
  return Array.from(bucket.entries())
    .map(([date, b]) => ({ date, value: b.n ? b.sum / b.n : null }))
    .filter(d => d.value !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function computeYoYFromLevel(monthlyObs) {
  const out = [];
  const vals = monthlyObs.map(o => o.value);
  for (let i = 12; i < monthlyObs.length; i++) {
    const cur = vals[i];
    const prev = vals[i - 12];
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) continue;
    out.push({ date: monthlyObs[i].date, value: (cur / prev - 1) * 100 });
  }
  return out;
}

function quarterlyToMonthlyStepFill(qObs) {
  const out = [];
  for (const o of qObs) {
    const qDate = toMonthStart(o.date);
    const v = Number(o.value);
    if (!Number.isFinite(v)) continue;

    const m0 = qDate;
    const m1 = addMonths(m0, -1);
    const m2 = addMonths(m0, -2);
    out.push({ date: m2, value: v }, { date: m1, value: v }, { date: m0, value: v });
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
  const raw = await fredSeriesObservations(env, "NFCI");
  return monthlyAverageFromHighFreq(raw);
}

async function buildMonthlyLevel(env, seriesId, windowMonths, horizonMonths, opts) {
  const scenario = opts?.scenario || "baseline";
  const nfciShock = Number(opts?.nfciShock) || 0;
  const ffShock = Number(opts?.ffShock) || 0;
  const nfciLatestGlobal = Number(opts?.nfciLatestGlobal) || 0;
  const seriesKey = opts?.seriesKey || seriesId;
  const anchor = opts?.anchor ?? null;

  const raw = await fredSeriesObservations(env, seriesId);
  const monthly = toMonthlyAligned(raw);

  if (monthly.length < windowMonths + 2) {
    throw new Error(`Not enough data for ${seriesId}. Have ${monthly.length} months.`);
  }

  const tail = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  // align values to full labels
  const map = new Map(monthly.map(o => [o.date, o.value]));
  const full = labels.map(d => (map.has(d) ? map.get(d) : null));
  const historyWindow = full.slice(0, windowMonths).filter(v => v !== null);

  // if we lost nulls due to filter, rebuild proper historyWindow with null-safe last tail
  const histRaw = full.slice(0, windowMonths);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));
  if (histClean.length < 24) {
    // still proceed, but with what we have
  }

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths,
    scenario,
    nfciLatest: nfciLatestGlobal,
    seriesKey,
    nfciShock,
    ffShock
  });

  // IMPORTANT: keep the same "windowMonths" history length in the returned object
  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => (v == null ? null : round2(v))), fc, anchor);
}

async function buildNFCIMonthly(env, windowMonths, horizonMonths, opts) {
  const scenario = opts?.scenario || "baseline";
  const nfciShock = Number(opts?.nfciShock) || 0;
  const ffShock = Number(opts?.ffShock) || 0;

  const monthly = await fetchNFCIMonthlyAverages(env);

  if (monthly.length < windowMonths + 2) {
    throw new Error(`Not enough data for NFCI. Have ${monthly.length} months.`);
  }

  const tail = extractHistoryTail(monthly, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map = new Map(monthly.map(o => [o.date, o.value]));
  const full = labels.map(d => (map.has(d) ? map.get(d) : null));
  const histRaw = full.slice(0, windowMonths);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));
  const nfciLatest = histClean.length ? histClean[histClean.length - 1] : 0;

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths,
    scenario,
    nfciLatest,
    seriesKey: "NFCI",
    nfciShock,
    ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => (v == null ? null : round2(v))), fc, 0);
}

async function buildCPIYoY(env, windowMonths, horizonMonths, opts) {
  const scenario = opts?.scenario || "baseline";
  const nfciShock = Number(opts?.nfciShock) || 0;
  const ffShock = Number(opts?.ffShock) || 0;
  const nfciLatestGlobal = Number(opts?.nfciLatestGlobal) || 0;

  const raw = await fredSeriesObservations(env, "CPIAUCSL");
  const monthlyLvl = toMonthlyAligned(raw);
  const monthlyYoY = computeYoYFromLevel(monthlyLvl);

  if (monthlyYoY.length < windowMonths + 2) {
    throw new Error(`Not enough CPI YoY history. Have ${monthlyYoY.length} months.`);
  }

  const tail = extractHistoryTail(monthlyYoY, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map = new Map(monthlyYoY.map(o => [o.date, o.value]));
  const full = labels.map(d => (map.has(d) ? map.get(d) : null));
  const histRaw = full.slice(0, windowMonths);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths,
    scenario,
    nfciLatest: nfciLatestGlobal,
    seriesKey: "CPI",
    nfciShock,
    ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => (v == null ? null : round2(v))), fc, 2);
}

async function buildGDPYoYMonthly(env, windowMonths, horizonMonths, opts) {
  const scenario = opts?.scenario || "baseline";
  const nfciShock = Number(opts?.nfciShock) || 0;
  const ffShock = Number(opts?.ffShock) || 0;
  const nfciLatestGlobal = Number(opts?.nfciLatestGlobal) || 0;

  // Real GDP level (quarterly) -> step-fill monthly -> YoY
  const rawQ = await fredSeriesObservations(env, "GDPC1");
  const qAsMonthly = quarterlyToMonthlyStepFill(rawQ);
  const monthlyYoY = computeYoYFromLevel(qAsMonthly);

  if (monthlyYoY.length < windowMonths + 2) {
    throw new Error(`Not enough GDP YoY monthly history. Have ${monthlyYoY.length} months.`);
  }

  const tail = extractHistoryTail(monthlyYoY, windowMonths);
  const lastMonth01 = tail.labels[tail.labels.length - 1];
  const labels = buildMonthlyLabels(lastMonth01, windowMonths, horizonMonths);

  const map = new Map(monthlyYoY.map(o => [o.date, o.value]));
  const full = labels.map(d => (map.has(d) ? map.get(d) : null));
  const histRaw = full.slice(0, windowMonths);
  const histClean = histRaw.filter(v => v !== null && Number.isFinite(v));

  const fc = forecastMonteCarlo({
    historyValues: histClean,
    historyLabels: tail.labels.slice(-histClean.length),
    horizonMonths,
    scenario,
    nfciLatest: nfciLatestGlobal,
    seriesKey: "GDP",
    nfciShock,
    ffShock
  });

  return padSeries(labels, windowMonths, horizonMonths, histRaw.map(v => (v == null ? null : round2(v))), fc, null);
}

/* =========================
   NARRATIVE (STRING)
========================= */
function fmt(x, digits = 2) {
  if (x === null || x === undefined) return "—";
  if (!Number.isFinite(Number(x))) return "—";
  return Number(x).toFixed(digits);
}

function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return v;
  }
  return null;
}

function slopeLabel(a, b) {
  const d = b - a;
  if (!Number.isFinite(d)) return "mixed";
  if (Math.abs(d) < 0.05) return "roughly flat";
  return d > 0 ? "rising" : "falling";
}

function summarizeSeriesForNarrative(name, key, s) {
  // s.forecast is padded: null..null + horizon values
  const f = s.forecast || [];
  const p10 = s.p10_forecast || [];
  const p90 = s.p90_forecast || [];
  const latest = s.latest ?? lastNonNull(s.history || []);
  const endMean = lastNonNull(f);
  const endP10 = lastNonNull(p10);
  const endP90 = lastNonNull(p90);

  const d = (endMean != null && latest != null) ? (endMean - latest) : null;
  const bw = (endP90 != null && endP10 != null) ? (endP90 - endP10) : null;

  return {
    name,
    key,
    latest,
    endMean,
    delta: d,
    band: bw,
    trend: (latest != null && endMean != null) ? slopeLabel(latest, endMean) : "mixed"
  };
}

function makeNarrativeFromForecasts(payload) {
  const { updated, year, horizonMonths, windowMonths, scenario, nfciShock, ffShock, question, series } = payload;

  const rows = [
    summarizeSeriesForNarrative("Inflation (CPI YoY)", "cpi", series.cpi),
    summarizeSeriesForNarrative("Unemployment (UNRATE)", "u", series.unrate),
    summarizeSeriesForNarrative("Fed Funds (Policy)", "ff", series.fedfunds),
    summarizeSeriesForNarrative("Industrial Production", "ip", series.indpro),
    summarizeSeriesForNarrative("Real GDP (YoY)", "gdp", series.gdp),
    summarizeSeriesForNarrative("Financial Conditions (NFCI)", "fci", series.nfci),
  ];

  const pctKeys = new Set(["cpi", "u", "ff", "gdp"]);
  const line = (r) => {
    const suf = pctKeys.has(r.key) ? "%" : "";
    const drift =
      r.delta == null ? "—" :
      r.delta > 0 ? `up ~${fmt(r.delta, 2)}${suf}` :
      r.delta < 0 ? `down ~${fmt(Math.abs(r.delta), 2)}${suf}` : "flat";

    const conf =
      r.band == null ? "uncertainty unknown" :
      r.band > 2 ? "wide uncertainty" :
      r.band > 1 ? "moderate uncertainty" : "tighter band";

    return `- ${r.name}: latest ${fmt(r.latest, 2)}${suf} → end ${fmt(r.endMean, 2)}${suf} (${drift}); ${conf}.`;
  };

  const shockLine =
    (nfciShock || ffShock)
      ? `Shocks: ΔNFCI ${nfciShock >= 0 ? "+" : ""}${fmt(nfciShock, 2)}, ΔFF ${ffShock >= 0 ? "+" : ""}${fmt(ffShock, 2)}pp.`
      : "Shocks: none (0).";

  return (
`US Economy ${year} Outlook (updated ${updated})
Scenario: ${String(scenario).replaceAll("_", " ")} · Horizon: ${horizonMonths}m · Window: ${windowMonths}m
Question: "${question}"
${shockLine}

Readout (mean + P10–P90)
${rows.map(line).join("\n")}

Key risks (mechanics)
- If NFCI trends toward/above 0 (tighter), growth pressure typically follows with a lag.
- If CPI stops cooling while unemployment rises, the policy path can stay restrictive longer.
- If uncertainty bands widen materially, treat the direction as low-confidence.

Not financial advice.`
  );
}

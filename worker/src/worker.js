export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);

      const body = await request.json();
      const question = (body.question || "").toString().trim();
      const horizonMonths = Number(body.horizonMonths || 24);
      const windowMonths = Number(body.windowMonths || 36);

      if (!question) return json({ error: "Missing question" }, 400, cors);

      // 1) Fetch FRED monthly series
      const seriesIds = {
        CPI: "CPIAUCSL",
        UNRATE: "UNRATE",
        FEDFUNDS: "FEDFUNDS",
        INDPRO: "INDPRO",
      };

      const fred = {};
      for (const key of Object.keys(seriesIds)) {
        fred[key] = await fredSeries(env.FRED_API_KEY, seriesIds[key]);
      }

      const dataLastUpdated = latestDateAcross(fred);

      // 2) CPI -> YoY inflation %
      const cpiYoY = computeYoYPercent(fred.CPI);

      // 3) Window
      const unrateWin = lastN(fred.UNRATE, windowMonths);
      const fedWin = lastN(fred.FEDFUNDS, windowMonths);
      const indproWin = lastN(fred.INDPRO, windowMonths);
      const cpiYoYWin = lastN(cpiYoY, windowMonths);

      // 4) Forecasts + bands
      const fc_unrate = holtForecastWithBands(unrateWin.map(x => x.value), horizonMonths);
      const fc_fed    = holtForecastWithBands(fedWin.map(x => x.value), horizonMonths);
      const fc_indpro = holtForecastWithBands(indproWin.map(x => x.value), horizonMonths);
      const fc_cpi    = holtForecastWithBands(cpiYoYWin.map(x => x.value), horizonMonths);

      // 5) Future date labels (monthly)
      const lastDate = unrateWin.at(-1)?.date || dataLastUpdated;
      const futureDates = buildFutureMonthlyDates(lastDate, horizonMonths);

      // 6) Chart payload (history + forecast + bands)
      const charts = {
        cpi_yoy: {
          title: "CPI Inflation (YoY %)",
          labels: [...cpiYoYWin.map(x => x.date), ...futureDates],
          history: [...cpiYoYWin.map(x => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(cpiYoYWin.length).fill(null), ...fc_cpi.forecast],
          lower:   [...Array(cpiYoYWin.length).fill(null), ...fc_cpi.lower],
          upper:   [...Array(cpiYoYWin.length).fill(null), ...fc_cpi.upper],
          unit: "%",
          forecast_start_index: cpiYoYWin.length - 1
        },
        unrate: {
          title: "Unemployment Rate (%)",
          labels: [...unrateWin.map(x => x.date), ...futureDates],
          history: [...unrateWin.map(x => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(unrateWin.length).fill(null), ...fc_unrate.forecast],
          lower:   [...Array(unrateWin.length).fill(null), ...fc_unrate.lower],
          upper:   [...Array(unrateWin.length).fill(null), ...fc_unrate.upper],
          unit: "%",
          forecast_start_index: unrateWin.length - 1
        },
        fedfunds: {
          title: "Fed Funds Rate (%)",
          labels: [...fedWin.map(x => x.date), ...futureDates],
          history: [...fedWin.map(x => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(fedWin.length).fill(null), ...fc_fed.forecast],
          lower:   [...Array(fedWin.length).fill(null), ...fc_fed.lower],
          upper:   [...Array(fedWin.length).fill(null), ...fc_fed.upper],
          unit: "%",
          forecast_start_index: fedWin.length - 1
        },
        indpro: {
          title: "Industrial Production (Index)",
          labels: [...indproWin.map(x => x.date), ...futureDates],
          history: [...indproWin.map(x => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(indproWin.length).fill(null), ...fc_indpro.forecast],
          lower:   [...Array(indproWin.length).fill(null), ...fc_indpro.lower],
          upper:   [...Array(indproWin.length).fill(null), ...fc_indpro.upper],
          unit: "index",
          forecast_start_index: indproWin.length - 1
        },
      };

      // 7) Narrative with OpenAI
      const snapshot = {
        last_updated: dataLastUpdated,
        latest: {
          cpi_yoy: cpiYoYWin.at(-1)?.value,
          unrate: unrateWin.at(-1)?.value,
          fedfunds: fedWin.at(-1)?.value,
          indpro: indproWin.at(-1)?.value,
        },
        horizon_months: horizonMonths,
        window_months: windowMonths,
        uncertainty_note: "Bands are RMSE-based from one-step-ahead residuals of Holt fit (approx 95%)."
      };

      const prompt = [
        {
          role: "system",
          content:
            "You are a cautious macro forecaster. Use the provided snapshot and explain what the charts imply. " +
            "Write in clear sections and bullets. Keep it short and professional."
        },
        {
          role: "user",
          content:
            `User question: ${question}\n\n` +
            `Data snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\n` +
            `Model:\n- Holt linear smoothing (level + trend)\n- Window: last ${windowMonths} months\n- Horizon: ${horizonMonths} months\n` +
            `- Uncertainty: RMSE-based ~95% band\n\n` +
            `Write a 2026-oriented narrative (even if horizon is short), and refer to each chart briefly.`
        }
      ];

      const openaiResp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.2",
          input: prompt,
        })
      });

      if (!openaiResp.ok) {
        const detail = await openaiResp.text();
        return json({ error: "OpenAI error", detail }, 500, cors);
      }

      const openaiJson = await openaiResp.json();
      const answer = extractResponseText(openaiJson);

      return json({ answer, data_last_updated: dataLastUpdated, charts, snapshot }, 200, cors);

    } catch (e) {
      return json({ error: e?.message || "Unknown error" }, 500, cors);
    }
  }
};

// ---------- Helpers ----------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

async function fredSeries(apiKey, seriesId) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey || "");
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "asc");

  const r = await fetch(url.toString());
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`FRED failed for ${seriesId} (${r.status}): ${text.slice(0, 200)}`);
  }

  const j = JSON.parse(text);

  return (j.observations || [])
    .map(o => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
    .filter(o => o.value !== null);
}

function latestDateAcross(fred) {
  let latest = "1900-01-01";
  for (const k of Object.keys(fred)) {
    const arr = fred[k];
    if (arr.length) {
      const d = arr[arr.length - 1].date;
      if (d > latest) latest = d;
    }
  }
  return latest;
}

function lastN(arr, n) {
  if (!arr || arr.length <= n) return arr;
  return arr.slice(-n);
}

// CPI YoY % = (CPI_t / CPI_{t-12} - 1) * 100
function computeYoYPercent(monthlySeries) {
  const out = [];
  for (let i = 12; i < monthlySeries.length; i++) {
    const cur = monthlySeries[i];
    const prev = monthlySeries[i - 12];
    const yoy = ((cur.value / prev.value) - 1) * 100;
    out.push({ date: cur.date, value: Number(yoy.toFixed(2)) });
  }
  return out;
}

// Holt linear smoothing + RMSE-based ~95% band
function holtForecastWithBands(values, horizon, alpha = 0.35, beta = 0.15, z = 1.96) {
  if (!values || values.length < 6) {
    const last = values?.at(-1) ?? null;
    return {
      forecast: Array(horizon).fill(last),
      sigma: 0,
      lower: Array(horizon).fill(last),
      upper: Array(horizon).fill(last),
    };
  }

  let level = values[0];
  let trend = values[1] - values[0];

  const errors = [];

  for (let t = 1; t < values.length; t++) {
    const y = values[t];
    const yhat = level + trend;
    errors.push(y - yhat);

    const prevLevel = level;
    level = alpha * y + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const mse = errors.reduce((s, e) => s + e * e, 0) / Math.max(1, errors.length);
  const sigma = Math.sqrt(mse);

  const forecast = [];
  const lower = [];
  const upper = [];

  for (let h = 1; h <= horizon; h++) {
    const f = level + h * trend;
    forecast.push(Number(f.toFixed(2)));
    lower.push(Number((f - z * sigma).toFixed(2)));
    upper.push(Number((f + z * sigma).toFixed(2)));
  }

  return { forecast, sigma: Number(sigma.toFixed(2)), lower, upper };
}

function buildFutureMonthlyDates(lastDateStr, horizonMonths) {
  const [y, m] = lastDateStr.split("-").map(Number);
  const dates = [];

  let year = y;
  let month = m;

  for (let i = 1; i <= horizonMonths; i++) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const mm = String(month).padStart(2, "0");
    dates.push(`${year}-${mm}-01`);
  }
  return dates;
}

function extractResponseText(openaiJson) {
  const items = openaiJson.output || [];
  for (const it of items) {
    const content = it.content || [];
    for (const c of content) {
      if (c.type === "output_text" && c.text) return c.text;
    }
  }
  if (openaiJson.output_text) return openaiJson.output_text;
  return "(No answer returned)";
}

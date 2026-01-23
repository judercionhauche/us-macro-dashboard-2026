export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      const url = new URL(request.url);

      // Optional META endpoint (frontend can call this)
      if (request.method === "GET" && url.pathname === "/meta") {
        return json(
          {
            availableYears: [2024, 2025, 2026],
            maxHorizonMonths: 24,
            defaultWindowMonths: 36,
          },
          200,
          cors
        );
      }

      // Forecast endpoint
      if (url.pathname !== "/forecast") {
        return json({ error: "Not found. Use /forecast" }, 404, cors);
      }

      if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);

      const body = await request.json();

      const question = (body.question || "").toString().trim();
      const horizonMonths = Number(body.horizonMonths || 12);
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

      const updated = latestDateAcross(fred);

      // 2) CPI -> YoY inflation %
      const cpiYoY = computeYoYPercent(fred.CPI);

      // 3) Window slice
      const unrateWin = lastN(fred.UNRATE, windowMonths);
      const fedWin = lastN(fred.FEDFUNDS, windowMonths);
      const indproWin = lastN(fred.INDPRO, windowMonths);
      const cpiYoYWin = lastN(cpiYoY, windowMonths);

      // 4) Forecasts
      const fc_unrate = holtForecast(unrateWin.map((x) => x.value), horizonMonths);
      const fc_fed = holtForecast(fedWin.map((x) => x.value), horizonMonths);
      const fc_indpro = holtForecast(indproWin.map((x) => x.value), horizonMonths);
      const fc_cpi = holtForecast(cpiYoYWin.map((x) => x.value), horizonMonths);

      // 5) Future monthly labels
      const lastDate = unrateWin.at(-1)?.date || updated;
      const futureDates = buildFutureMonthlyDates(lastDate, horizonMonths);

      // 6) Build frontend "series" format (IMPORTANT)
      const series = {
        cpi: {
          labels: [...cpiYoYWin.map((x) => x.date), ...futureDates],
          history: [...cpiYoYWin.map((x) => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(cpiYoYWin.length).fill(null), ...fc_cpi],
          latest: cpiYoYWin.at(-1)?.value ?? null,
        },
        unemployment: {
          labels: [...unrateWin.map((x) => x.date), ...futureDates],
          history: [...unrateWin.map((x) => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(unrateWin.length).fill(null), ...fc_unrate],
          latest: unrateWin.at(-1)?.value ?? null,
        },
        fedFunds: {
          labels: [...fedWin.map((x) => x.date), ...futureDates],
          history: [...fedWin.map((x) => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(fedWin.length).fill(null), ...fc_fed],
          latest: fedWin.at(-1)?.value ?? null,
        },
        industrialProduction: {
          labels: [...indproWin.map((x) => x.date), ...futureDates],
          history: [...indproWin.map((x) => x.value), ...Array(horizonMonths).fill(null)],
          forecast: [...Array(indproWin.length).fill(null), ...fc_indpro],
          latest: indproWin.at(-1)?.value ?? null,
        },
      };

      // 7) Narrative prompt
      const snapshot = {
        updated,
        horizonMonths,
        windowMonths,
        latest: {
          cpi: series.cpi.latest,
          unemployment: series.unemployment.latest,
          fedFunds: series.fedFunds.latest,
          industrialProduction: series.industrialProduction.latest,
        },
      };

      const prompt = [
        {
          role: "system",
          content:
            "You are a concise macro forecaster. Write a clean narrative with headings and short bullet points. " +
            "Avoid markdown over-formatting like ***. Use simple bold only when needed.",
        },
        {
          role: "user",
          content:
            `User question: ${question}\n\n` +
            `Snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\n` +
            `Explain what each chart implies and give a 2026 baseline view. Keep it tight and readable.`,
        },
      ];

      // 8) OpenAI call
      const openaiResp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.2",
          input: prompt,
        }),
      });

      if (!openaiResp.ok) {
        const detail = await openaiResp.text();
        return json({ error: "OpenAI error", detail }, 500, cors);
      }

      const openaiJson = await openaiResp.json();
      const narrative = extractResponseText(openaiJson);

      // ✅ FINAL RESPONSE SHAPE (frontend expects THIS)
      return json(
        {
          updated,
          params: {
            horizonMonths,
            windowMonths,
          },
          series,
          narrative,
        },
        200,
        cors
      );
    } catch (e) {
      return json({ error: e?.message || "Unknown error" }, 500, cors);
    }
  },
};

// ---------- Helpers ----------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
    .map((o) => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
    .filter((o) => o.value !== null);
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

// Holt smoothing (simple) -> forecast array
function holtForecast(values, horizon, alpha = 0.35, beta = 0.15) {
  if (!values || values.length < 6) {
    const last = values?.at(-1) ?? null;
    return Array(horizon).fill(last);
  }

  let level = values[0];
  let trend = values[1] - values[0];

  for (let t = 1; t < values.length; t++) {
    const y = values[t];
    const prevLevel = level;
    level = alpha * y + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Number((level + h * trend).toFixed(2)));
  }
  return forecast;
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
  return "(No narrative returned)";
}

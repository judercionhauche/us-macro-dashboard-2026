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

      const { question } = await request.json();
      const q = (question || "").toString().trim();
      if (!q) return json({ error: "Missing question" }, 400, cors);

      // ---- Fetch live FRED series ----
      const series = ["GDPC1", "CPIAUCSL", "UNRATE", "FEDFUNDS"];
      const fred = {};
      for (const s of series) fred[s] = await fredSeries(env.FRED_API_KEY, s);

      const dataLastUpdated = latestDateAcross(fred);
      const baseline = buildBaseline2026(fred);

      // ---- OpenAI Responses API call ----
      const schema = {
        name: "us_econ_2026_forecast",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            headline: { type: "string" },
            numbers: {
              type: "object",
              additionalProperties: false,
              properties: {
                real_gdp_growth_2026: { type: "string" },
                cpi_inflation_2026: { type: "string" },
                unemployment_2026: { type: "string" },
                fed_funds_end_2026: { type: "string" }
              },
              required: ["real_gdp_growth_2026","cpi_inflation_2026","unemployment_2026","fed_funds_end_2026"]
            },
            reasoning: { type: "string" },
            risks: { type: "array", items: { type: "string" } },
            what_to_watch: { type: "array", items: { type: "string" } },
            data_notes: { type: "string" }
          },
          required: ["headline","numbers","reasoning","risks","what_to_watch","data_notes"]
        }
      };

      const input = [
        {
          role: "system",
          content:
            "You are a cautious macro forecaster. Use ONLY the provided data + baseline. " +
            "Be clear about uncertainty. Keep it readable."
        },
        {
          role: "user",
          content:
            `Question: ${q}\n\n` +
            `Latest observation date across series: ${dataLastUpdated}\n\n` +
            `Baseline (transparent heuristic):\n${JSON.stringify(baseline, null, 2)}\n\n` +
            `Recent data snapshots:\n${JSON.stringify(trimForPrompt(fred), null, 2)}\n\n` +
            `Write a 2026 forecast focusing on GDP, inflation, unemployment, and interest rates.`
        }
      ];

     const r = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    input,
    text: {
      format: {
        type: "json_schema",
        name: schema.name,
        schema: schema.schema,
        strict: true
      }
    }
  })
});


      if (!r.ok) {
        const detail = await r.text();
        return json({ error: "OpenAI error", detail }, 500, cors);
      }

      const openaiJson = await r.json();
      const outText = extractResponseText(openaiJson);
      const structured = JSON.parse(outText);

      const answer = formatAnswer(structured, dataLastUpdated);

      return json({ answer, data_last_updated: dataLastUpdated, baseline }, 200, cors);
    } catch (e) {
      return json({ error: e?.message || "Unknown error" }, 500, cors);
    }
  }
};

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

async function fredSeries(apiKey, seriesId) {
  if (!apiKey) throw new Error(`Missing FRED_API_KEY in env for ${seriesId}`);

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "asc");

  const r = await fetch(url.toString());

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`FRED failed for ${seriesId} | status=${r.status} | body=${body.slice(0, 200)}`);
  }

  const j = await r.json();
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

function yoyFromMonthly(series) {
  const n = series.length;
  if (n < 13) return null;
  const last = series[n - 1].value;
  const prev = series[n - 13].value;
  return (last / prev) - 1;
}

function lastValue(series) {
  return series.length ? series[series.length - 1].value : null;
}

function annualizedQoqFromQuarterly(series) {
  const n = series.length;
  if (n < 2) return null;
  const last = series[n - 1].value;
  const prev = series[n - 2].value;
  return Math.pow(last / prev, 4) - 1;
}

function blendPct(a, b, weightA) {
  if (a == null) return b;
  return (a * weightA) + (b * (1 - weightA));
}

function pct(x) {
  if (x == null || Number.isNaN(x)) return null;
  return `${(x * 100).toFixed(1)}%`;
}

function buildBaseline2026(fred) {
  const gdp_qoq_ann = annualizedQoqFromQuarterly(fred.GDPC1);
  const cpi_yoy = yoyFromMonthly(fred.CPIAUCSL);
  const unrate = lastValue(fred.UNRATE);
  const ff = lastValue(fred.FEDFUNDS);

  const gdp_2026 = blendPct(gdp_qoq_ann, 0.02, 0.45);
  const infl_2026 = blendPct(cpi_yoy, 0.025, 0.50);

  const un_2026 = unrate != null ? (unrate + 0.2) : null;
  const ff_end_2026 = ff != null ? Math.max(0, ff - 0.25) : null;

  return {
    method: "Heuristic baseline (mean reversion + small drifts).",
    inputs: {
      last_gdp_qoq_annualized: pct(gdp_qoq_ann),
      last_cpi_yoy: pct(cpi_yoy),
      last_unemployment: unrate,
      last_fed_funds: ff
    },
    baseline_2026: {
      real_gdp_growth: pct(gdp_2026),
      cpi_inflation: pct(infl_2026),
      unemployment_rate: un_2026 != null ? `${un_2026.toFixed(1)}%` : null,
      fed_funds_end: ff_end_2026 != null ? `${ff_end_2026.toFixed(2)}%` : null
    }
  };
}

function trimForPrompt(fred) {
  const out = {};
  for (const k of Object.keys(fred)) out[k] = fred[k].slice(-18);
  return out;
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
  throw new Error("Could not extract model text");
}

function formatAnswer(s, dataLastUpdated) {
  return (
`🧭 Headline
${s.headline}

📌 2026 Key Numbers (illustrative)
- Real GDP growth: ${s.numbers.real_gdp_growth_2026}
- CPI inflation: ${s.numbers.cpi_inflation_2026}
- Unemployment: ${s.numbers.unemployment_2026}
- Fed funds (end of 2026): ${s.numbers.fed_funds_end_2026}

🧠 Reasoning (data through ${dataLastUpdated})
${s.reasoning}

⚠️ Risks
- ${s.risks.join("\n- ")}

👀 What to watch
- ${s.what_to_watch.join("\n- ")}

🗂️ Data notes
${s.data_notes}`
  );
}

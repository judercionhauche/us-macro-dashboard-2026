const API_URL = "https://us-econ-forecast-worker.judercionhauche.workers.dev";

// DOM
const runBtn = document.getElementById("runBtn");
const questionEl = document.getElementById("question");
const horizonEl = document.getElementById("horizon");
const windowEl = document.getElementById("window");

const updatedChip = document.getElementById("updatedChip");
const metaText = document.getElementById("metaText");
const methodChip = document.getElementById("methodChip");

const narrativeEl = document.getElementById("narrative");
const resultsEl = document.getElementById("results");
const emptyStateEl = document.getElementById("emptyState");

// KPI
const kpiCpi = document.getElementById("kpiCpi");
const kpiUnrate = document.getElementById("kpiUnrate");
const kpiFed = document.getElementById("kpiFed");
const kpiIndpro = document.getElementById("kpiIndpro");

const kpiCpiSub = document.getElementById("kpiCpiSub");
const kpiUnrateSub = document.getElementById("kpiUnrateSub");
const kpiFedSub = document.getElementById("kpiFedSub");
const kpiIndproSub = document.getElementById("kpiIndproSub");

// Mini
const miniCpi = document.getElementById("miniCpi");
const miniUnrate = document.getElementById("miniUnrate");
const miniFed = document.getElementById("miniFed");
const miniIndpro = document.getElementById("miniIndpro");

// Chart instances
const chartState = { cpi:null, unrate:null, fedfunds:null, indpro:null };

function destroyChart(key){
  if(chartState[key]){ chartState[key].destroy(); chartState[key]=null; }
}

function markdownLiteToHtml(text) {
  if (!text) return "";

  let t = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  t = t.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
  t = t.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
  t = t.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");

  // bullet blocks -> <ul>
  t = t.replace(/(?:^-\s.*(?:\n|$))+?/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map(line => line.replace(/^-+\s*/, "").trim())
      .filter(Boolean)
      .map(item => `<li>${item}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  t = t
    .split(/\n{2,}/)
    .map(chunk => {
      if (chunk.match(/^<h\d|^<ul/)) return chunk;
      return `<p>${chunk.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return t;
}

function pickChartsRoot(data){ return data?.charts || data?.series || data; }
function pickChart(obj, keys){
  for(const k of keys){ if(obj && obj[k]) return obj[k]; }
  return null;
}

function fmt(v, suffix=""){
  if(v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)}${suffix}`;
}

function lastNonNull(arr){
  for(let i=arr.length-1;i>=0;i--){
    const v = arr[i];
    if(v !== null && v !== undefined) return { value:v, idx:i };
  }
  return { value:null, idx:-1 };
}

function buildChart(canvasId, labels, history, forecast) {
  const ctx = document.getElementById(canvasId).getContext("2d");

  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "History", data: history, borderWidth: 2, pointRadius: 0, tension: 0.25 },
        { label: "Forecast", data: forecast, borderWidth: 2, borderDash: [6, 6], pointRadius: 0, tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxTicksLimit: 6 }, grid: { color: "rgba(15,23,42,0.06)" } },
        y: { grid: { color: "rgba(15,23,42,0.06)" } }
      }
    }
  });
}

runBtn.addEventListener("click", async () => {
  const question = questionEl.value.trim();
  const horizonMonths = Number(horizonEl.value);
  const windowMonths = Number(windowEl.value);

  runBtn.disabled = true;
  runBtn.querySelector(".btnText").textContent = "Running…";
  resultsEl.classList.add("hidden");

  emptyStateEl.innerHTML = `
    <div class="emptyTitle">Running forecast…</div>
    <div class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    Fetching FRED + generating charts…</div>
  `;

  try {
    const res = await fetch(`${API_URL}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, horizonMonths, windowMonths })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Worker error: ${res.status}`);

    const updated = data.updated || data.data_last_updated || data.last_updated || "—";
    updatedChip.textContent = `Updated: ${updated}`;
    metaText.textContent = `Window: ${windowMonths} months • Horizon: ${horizonMonths} months`;

    const narrative = data.narrative || data.answer || data.text || "(No narrative returned)";
    narrativeEl.innerHTML = markdownLiteToHtml(narrative);

    const root = pickChartsRoot(data);
    const cpi = pickChart(root, ["cpi_yoy","cpi","CPI"]);
    const unrate = pickChart(root, ["unrate","UNRATE"]);
    const fedfunds = pickChart(root, ["fedfunds","fed","FEDFUNDS"]);
    const indpro = pickChart(root, ["indpro","INDPRO"]);

    if (!cpi || !unrate || !fedfunds || !indpro) {
      console.log("Worker response:", data);
      throw new Error("Missing chart series in worker response.");
    }
    const mustHave = (s) => s.labels && s.history && s.forecast;
    if (![cpi, unrate, fedfunds, indpro].every(mustHave)) {
      console.log("Worker response:", data);
      throw new Error("Chart objects missing labels/history/forecast.");
    }

    // Build charts
    destroyChart("cpi"); destroyChart("unrate"); destroyChart("fedfunds"); destroyChart("indpro");
    chartState.cpi = buildChart("chartCpi", cpi.labels, cpi.history, cpi.forecast);
    chartState.unrate = buildChart("chartUnrate", unrate.labels, unrate.history, unrate.forecast);
    chartState.fedfunds = buildChart("chartFed", fedfunds.labels, fedfunds.history, fedfunds.forecast);
    chartState.indpro = buildChart("chartIndpro", indpro.labels, indpro.history, indpro.forecast);

    // KPIs from last non-null history point
    const lc = lastNonNull(cpi.history);
    const lu = lastNonNull(unrate.history);
    const lf = lastNonNull(fedfunds.history);
    const li = lastNonNull(indpro.history);

    kpiCpi.textContent = fmt(lc.value, "%");
    kpiUnrate.textContent = fmt(lu.value, "%");
    kpiFed.textContent = fmt(lf.value, "%");
    kpiIndpro.textContent = fmt(li.value, "");

    kpiCpiSub.textContent = lc.idx >= 0 ? `latest (${cpi.labels[lc.idx]})` : "latest";
    kpiUnrateSub.textContent = lu.idx >= 0 ? `latest (${unrate.labels[lu.idx]})` : "latest";
    kpiFedSub.textContent = lf.idx >= 0 ? `latest (${fedfunds.labels[lf.idx]})` : "latest";
    kpiIndproSub.textContent = li.idx >= 0 ? `latest (${indpro.labels[li.idx]})` : "latest";

    miniCpi.textContent = `Latest: ${fmt(lc.value, "%")}`;
    miniUnrate.textContent = `Latest: ${fmt(lu.value, "%")}`;
    miniFed.textContent = `Latest: ${fmt(lf.value, "%")}`;
    miniIndpro.textContent = `Latest: ${fmt(li.value, "")}`;

    methodChip.textContent = "Holt trend";

    // show results
    resultsEl.classList.remove("hidden");
    resultsEl.classList.add("fade-in");

    // tip state
    emptyStateEl.innerHTML = `
      <div class="emptyTitle">Tip</div>
      <div class="emptyDesc">Try switching horizon/window and compare how “trend extrapolation” shifts the 2026 story.</div>
    `;
  } catch (err) {
    narrativeEl.innerHTML = `<p><b>Error:</b> ${err.message}</p>`;
    emptyStateEl.innerHTML = `
      <div class="emptyTitle">Something went wrong</div>
      <div class="emptyDesc">${err.message}</div>
    `;
    resultsEl.classList.add("hidden");
  } finally {
    runBtn.disabled = false;
    runBtn.querySelector(".btnText").textContent = "Run";
  }
});

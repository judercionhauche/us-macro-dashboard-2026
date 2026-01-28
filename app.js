/* =========================
   CONFIG
========================= */
const API_URL = "https://us-econ-forecast-worker.judercionhauche.workers.dev";

/* =========================
   DOM
========================= */
const $ = (id) => document.getElementById(id);

const runBtn = $("runBtn");
const sendBtn = $("sendBtn");
const resetBtn = $("resetBtn");
const chatInput = $("chatInput");
const chatBox = $("chatBox");
const results = $("results");
const updatedLabel = $("updatedLabel");
const knobPills = $("knobPills");

const yearNow = $("yearNow");
yearNow.textContent = new Date().getFullYear();

/* Macro Lab */
const scenarioSelect = $("scenarioSelect");
const nfciShock = $("nfciShock");
const ffShock = $("ffShock");
const nfciShockVal = $("nfciShockVal");
const ffShockVal = $("ffShockVal");
const applyLabBtn = $("applyLabBtn");

/* KPI elements */
const KPI = {
  cpi: { val: $("kpiCpi"), meta: $("kpiCpiMeta") },
  u:   { val: $("kpiU"),   meta: $("kpiUMeta") },
  ff:  { val: $("kpiFf"),  meta: $("kpiFfMeta") },
  ip:  { val: $("kpiIp"),  meta: $("kpiIpMeta") },
  gdp: { val: $("kpiGdp"), meta: $("kpiGdpMeta") },
  fci: { val: $("kpiFci"), meta: $("kpiFciMeta") },
};

const LatestLabels = {
  cpi: $("cpiLatest"),
  u: $("uLatest"),
  ff: $("ffLatest"),
  ip: $("ipLatest"),
  gdp: $("gdpLatest"),
  fci: $("fciLatest"),
};

const narrativeText = $("narrativeText");

/* =========================
   STATE
========================= */
const state = {
  year: 2026,
  horizonMonths: 12,
  windowMonths: 36,
  pending: null, // "horizon" | "window" | null
  lastQuestion: "Give me a forecast for the US economy in 2026",
  charts: {}, // chart instances

  scenario: "baseline",
  shocks: {
    nfci: 0.0,
    ff: 0.0,
  },
};

/* =========================
   UTIL
========================= */
function addBubble(text, who = "assistant") {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setPills() {
  knobPills.innerHTML = "";
  const items = [
    { k: "Year", v: String(state.year) },
    { k: "Horizon", v: `${state.horizonMonths}m` },
    { k: "Window", v: `${state.windowMonths}m` },
    { k: "Scenario", v: state.scenario.replaceAll("_", " ") },
    { k: "ΔNFCI", v: state.shocks.nfci.toFixed(2) },
    { k: "ΔFF", v: state.shocks.ff.toFixed(2) },
  ];
  for (const it of items) {
    const p = document.createElement("span");
    p.className = "pillMini";
    p.innerHTML = `<strong>${it.k}:</strong> ${it.v}`;
    knobPills.appendChild(p);
  }
}

function parseYear(text) {
  const m = text.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 2000 || y > 2100) return null;
  return y;
}

function parseHorizon(text) {
  const m =
    text.match(/horizon\s*[:=]?\s*(\d{1,2})\b/i) ||
    text.match(/\b(\d{1,2})\s*(?:months|month)\b/i) ||
    text.match(/\b(\d{1,2})m\b/i);

  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0 || n > 60) return null;
  return n;
}

function parseWindow(text) {
  const m =
    text.match(/window\s*[:=]?\s*(\d{1,3})\b/i) ||
    text.match(/\bwindow\s*(\d{1,3})\b/i);

  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 12 || n > 240) return null;
  return n;
}

function fmt(x, digits = 2) {
  if (x === null || x === undefined) return "—";
  if (!Number.isFinite(Number(x))) return "—";
  return Number(x).toFixed(digits);
}

/* =========================
   CHARTS
========================= */
function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function buildDatasets(series, { showAnchor = false, anchorLabel = "Anchor" } = {}) {
  const labels = series.labels || [];
  const history = series.history || [];
  const forecast = series.forecast || [];
  const p10 = series.p10_forecast || null;
  const p90 = series.p90_forecast || null;

  const ds = [];

  ds.push({
    label: "History",
    data: history,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.28,
    spanGaps: true,
  });

  if (p10 && p90) {
    ds.push({
      label: "P10",
      data: p10,
      borderWidth: 1,
      pointRadius: 0,
      tension: 0.28,
      spanGaps: true,
      borderDash: [2, 3],
    });

    ds.push({
      label: "P10–P90 band",
      data: p90,
      borderWidth: 0,
      pointRadius: 0,
      tension: 0.28,
      spanGaps: true,
      fill: "-1",
    });
  }

  ds.push({
    label: "Forecast (mean)",
    data: forecast,
    borderWidth: 2,
    borderDash: [6, 4],
    pointRadius: 0,
    tension: 0.28,
    spanGaps: true,
  });

  if (showAnchor && series.anchor !== null && series.anchor !== undefined) {
    const a = Number(series.anchor);
    const arr = labels.map(() => a);
    ds.push({
      label: anchorLabel,
      data: arr,
      borderWidth: 2,
      borderDash: [3, 3],
      pointRadius: 0,
    });
  }

  return { labels, datasets: ds };
}

function renderChart(canvasId, series, opts = {}) {
  if (!series || !Array.isArray(series.labels)) return;

  destroyChart(canvasId);

  const ctx = $(canvasId).getContext("2d");
  const { labels, datasets } = buildDatasets(series, opts);

  state.charts[canvasId] = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 80,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 22 } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6 }, grid: { color: "rgba(0,0,0,0.06)" } },
        y: { grid: { color: "rgba(0,0,0,0.06)" } },
      },
    },
  });
}

/* =========================
   DATA BINDING
========================= */
function setKpi(key, value, updated) {
  if (!KPI[key]) return;
  const isPercent = (key === "cpi" || key === "u" || key === "ff" || key === "gdp");
  KPI[key].val.textContent = isPercent ? `${fmt(value, 2)}%` : fmt(value, 2);
  KPI[key].meta.textContent = updated ? `latest (${updated})` : "latest";
}

function setLatestLabel(key, value) {
  if (!LatestLabels[key]) return;
  const isPercent = (key === "cpi" || key === "u" || key === "ff" || key === "gdp");
  LatestLabels[key].textContent = isPercent ? `${fmt(value, 2)}%` : fmt(value, 2);
}

function showResults(raw) {
  results.hidden = false;

  const updated = raw.updated || "—";
  updatedLabel.textContent = updated;

  const S = raw.series || {};

  const map = [
    { local: "cpi", s: S.cpi, chart: "cpiChart", anchor: true, anchorLabel: "Fed target (2%)" },
    { local: "u", s: S.unemployment, chart: "uChart" },
    { local: "ff", s: S.fedFunds, chart: "ffChart" },
    { local: "ip", s: S.industrialProduction, chart: "ipChart" },
    { local: "gdp", s: S.gdp, chart: "gdpChart" },
    { local: "fci", s: (S.financialConditions || S.fci || S.nfci), chart: "fciChart", anchor: true, anchorLabel: "Neutral (0)" },
  ];

  for (const item of map) {
    if (!item.s) continue;

    const latest = item.s.latest;
    setLatestLabel(item.local, latest);
    setKpi(item.local, latest, updated);

    renderChart(item.chart, item.s, {
      showAnchor: !!item.anchor,
      anchorLabel: item.anchorLabel || "Anchor",
    });
  }

  narrativeText.textContent = raw.narrative || "—";
}

/* =========================
   API CALL
========================= */
async function runForecast(questionText) {
  const payload = {
    question: questionText || state.lastQuestion,
    year: state.year,
    horizonMonths: state.horizonMonths,
    windowMonths: state.windowMonths,

    // NEW: regime + stress tests
    scenario: state.scenario,
    shocks: {
      nfci: state.shocks.nfci,
      ff: state.shocks.ff,
    },
  };

  addBubble(
    `Running: ${state.scenario.replaceAll("_"," ")} · ΔNFCI ${state.shocks.nfci.toFixed(2)} · ΔFF ${state.shocks.ff.toFixed(2)}pp`,
    "assistant"
  );

  const res = await fetch(`${API_URL}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Forecast failed (${res.status}). ${t}`);
  }

  const raw = await res.json();
  showResults(raw);
  addBubble("Done. Want to stress-test harder, or switch regimes?", "assistant");
}

/* =========================
   CHAT LOGIC
========================= */
function handleUserMessage(text) {
  const msg = text.trim();
  if (!msg) return;

  addBubble(msg, "user");

  if (state.pending === "horizon") {
    const n = parseHorizon(msg) || (/^\d+$/.test(msg) ? parseInt(msg, 10) : null);
    if (!n || n <= 0 || n > 60) {
      addBubble("Please give a horizon in months (1–60). Example: 12", "assistant");
      return;
    }
    state.horizonMonths = n;
    state.pending = "window";
    setPills();
    addBubble("Quick check — what window in months? Example: 36", "assistant");
    return;
  }

  if (state.pending === "window") {
    const n = parseWindow(msg) || (/^\d+$/.test(msg) ? parseInt(msg, 10) : null);
    if (!n || n < 12 || n > 240) {
      addBubble("Please give a window in months (12–240). Example: 36", "assistant");
      return;
    }
    state.windowMonths = n;
    state.pending = null;
    setPills();
    runForecast(state.lastQuestion).catch((e) => {
      console.error(e);
      addBubble("Something went wrong running the forecast. Check console for details.", "assistant");
    });
    return;
  }

  const y = parseYear(msg);
  const h = parseHorizon(msg);
  const w = parseWindow(msg);

  if (y) state.year = y;
  if (h) state.horizonMonths = h;
  if (w) state.windowMonths = w;

  state.lastQuestion = msg;
  setPills();

  const horizonMissing = !h;
  const windowMissing = !w;

  if (horizonMissing || windowMissing) {
    if (horizonMissing) {
      state.pending = "horizon";
      addBubble("Quick check — what horizon in months? Example: 12", "assistant");
      return;
    }
    if (windowMissing) {
      state.pending = "window";
      addBubble("Quick check — what window in months? Example: 36", "assistant");
      return;
    }
  }

  runForecast(msg).catch((e) => {
    console.error(e);
    addBubble("Something went wrong running the forecast. Check console for details.", "assistant");
  });
}

/* =========================
   RESET
========================= */
function resetAll() {
  Object.keys(state.charts).forEach((id) => {
    if (state.charts[id]) state.charts[id].destroy();
    delete state.charts[id];
  });

  state.year = 2026;
  state.horizonMonths = 12;
  state.windowMonths = 36;
  state.pending = null;
  state.lastQuestion = "Give me a forecast for the US economy in 2026";

  // reset lab
  state.scenario = "baseline";
  state.shocks.nfci = 0.0;
  state.shocks.ff = 0.0;
  if (scenarioSelect) scenarioSelect.value = "baseline";
  if (nfciShock) nfciShock.value = "0";
  if (ffShock) ffShock.value = "0";
  if (nfciShockVal) nfciShockVal.textContent = "0.00";
  if (ffShockVal) ffShockVal.textContent = "0.00";

  results.hidden = true;
  updatedLabel.textContent = "—";
  knobPills.innerHTML = "";
  narrativeText.textContent = "";

  chatBox.innerHTML = `
    <div class="bubble assistant">
      Tell me what you want to forecast.<br />
      Example: <em>“Give me a forecast for the US economy in 2026.”</em><br /><br />
      If you don’t specify year/horizon/window, I’ll ask.
    </div>
  `;

  setPills();
}

function wireLab() {
  if (!scenarioSelect || !nfciShock || !ffShock) return;

  // reflect live labels (without running)
  const sync = () => {
    nfciShockVal.textContent = Number(nfciShock.value).toFixed(2);
    ffShockVal.textContent = Number(ffShock.value).toFixed(2);
  };
  sync();

  scenarioSelect.addEventListener("change", () => {
    state.scenario = scenarioSelect.value;
    setPills();
  });

  nfciShock.addEventListener("input", () => {
    state.shocks.nfci = Number(nfciShock.value);
    sync();
    setPills();
  });

  ffShock.addEventListener("input", () => {
    state.shocks.ff = Number(ffShock.value);
    sync();
    setPills();
  });

  applyLabBtn.addEventListener("click", () => {
    runForecast(state.lastQuestion).catch((e) => {
      console.error(e);
      addBubble("Lab apply failed. Check console.", "assistant");
    });
  });
}

function wire() {
  setPills();
  wireLab();

  runBtn.addEventListener("click", () => {
    handleUserMessage(chatInput.value || state.lastQuestion);
    chatInput.value = "";
  });

  sendBtn.addEventListener("click", () => {
    handleUserMessage(chatInput.value);
    chatInput.value = "";
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      handleUserMessage(chatInput.value);
      chatInput.value = "";
    }
  });

  resetBtn.addEventListener("click", resetAll);
}

wire();

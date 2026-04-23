/* ============================================================
   US MACRO DASHBOARD — Frontend v2
   ============================================================ */

const API_URL = "https://us-econ-forecast-worker.judercionhauche.workers.dev";

/* ---- DOM ---- */
const $ = (id) => document.getElementById(id);

const runBtn        = $("runBtn");
const sendBtn       = $("sendBtn");
const resetBtn      = $("resetBtn");
const chatInput     = $("chatInput");
const chatBox       = $("chatBox");
const results       = $("results");
const updatedLabel  = $("updatedLabel");
const knobPills     = $("knobPills");
const loadingBanner = $("loadingBanner");
const recSection    = $("recessionSection");
const recFill       = $("recFill");
const recPct        = $("recPct");
const recDesc       = $("recDesc");
const narrativeText = $("narrativeText");
const narrativeSrc  = $("narrativeSource");
const yearNow       = $("yearNow");

yearNow.textContent = new Date().getFullYear();

/* Scenario lab */
const scenarioSelect = $("scenarioSelect");
const nfciShock      = $("nfciShock");
const ffShock        = $("ffShock");
const nfciShockVal   = $("nfciShockVal");
const ffShockVal     = $("ffShockVal");
const applyLabBtn    = $("applyLabBtn");

/* ---- SERIES CONFIG ---- */
// Maps API key → DOM ids + chart colors + context
const SERIES_MAP = [
  {
    apiKey: "cpi",          local: "cpi",
    valEl: "kpiCpi",  chgEl: "kpiCpiChange", metaEl: "kpiCpiMeta", latestEl: "cpiLatest",
    chartId: "cpiChart",    isPct: true,
    showAnchor: true, anchorLabel: "Fed target (2%)",
    colors: { history: "#64748b", main: "#f97316", band: "rgba(249,115,22,0.12)", p10: "rgba(249,115,22,0.45)" },
    dirGoodDown: true,   // lower CPI is "good"
  },
  {
    apiKey: "unemployment", local: "u",
    valEl: "kpiU",    chgEl: "kpiUChange",   metaEl: "kpiUMeta",   latestEl: "uLatest",
    chartId: "uChart",      isPct: true,
    showAnchor: false,
    colors: { history: "#64748b", main: "#3b82f6", band: "rgba(59,130,246,0.12)", p10: "rgba(59,130,246,0.45)" },
    dirGoodDown: true,
  },
  {
    apiKey: "fedFunds",     local: "ff",
    valEl: "kpiFf",   chgEl: "kpiFfChange",  metaEl: "kpiFfMeta",  latestEl: "ffLatest",
    chartId: "ffChart",     isPct: true,
    showAnchor: false,
    colors: { history: "#64748b", main: "#a855f7", band: "rgba(168,85,247,0.12)", p10: "rgba(168,85,247,0.45)" },
    dirGoodDown: false,
  },
  {
    apiKey: "gdp",          local: "gdp",
    valEl: "kpiGdp",  chgEl: "kpiGdpChange", metaEl: "kpiGdpMeta", latestEl: "gdpLatest",
    chartId: "gdpChart",    isPct: true,
    showAnchor: false,
    colors: { history: "#64748b", main: "#10b981", band: "rgba(16,185,129,0.12)", p10: "rgba(16,185,129,0.45)" },
    dirGoodDown: false,  // higher GDP growth is good
  },
  {
    apiKey: "yieldCurve",   local: "t10y2y",
    valEl: "kpiT10y2y",chgEl: "kpiT10y2yChange",metaEl:"kpiT10y2yMeta",latestEl:"t10y2yLatest",
    chartId: "t10y2yChart", isPct: false,
    showAnchor: true, anchorLabel: "Neutral (0pp)",
    colors: { history: "#64748b", main: "#f43f5e", band: "rgba(244,63,94,0.12)", p10: "rgba(244,63,94,0.45)" },
    dirGoodDown: false,  // higher spread = less recession risk
  },
  {
    apiKey: "fci",          local: "fci",
    valEl: "kpiFci",  chgEl: "kpiFciChange", metaEl: "kpiFciMeta", latestEl: "fciLatest",
    chartId: "fciChart",    isPct: false,
    showAnchor: true, anchorLabel: "Neutral (0)",
    colors: { history: "#64748b", main: "#f59e0b", band: "rgba(245,158,11,0.12)", p10: "rgba(245,158,11,0.45)" },
    dirGoodDown: true,
  },
  {
    apiKey: "industrialProduction", local: "ip",
    valEl: "kpiIp",   chgEl: "kpiIpChange",  metaEl: "kpiIpMeta",  latestEl: "ipLatest",
    chartId: "ipChart",     isPct: false,
    showAnchor: false,
    colors: { history: "#64748b", main: "#14b8a6", band: "rgba(20,184,166,0.12)", p10: "rgba(20,184,166,0.45)" },
    dirGoodDown: false,
  },
  {
    apiKey: "consumerSentiment", local: "sent",
    valEl: "kpiSent", chgEl: "kpiSentChange",metaEl: "kpiSentMeta",latestEl: "umcsentLatest",
    chartId: "umcsentChart", isPct: false,
    showAnchor: false,
    colors: { history: "#64748b", main: "#818cf8", band: "rgba(129,140,248,0.12)", p10: "rgba(129,140,248,0.45)" },
    dirGoodDown: false,
  },
];

/* ---- STATE ---- */
const state = {
  year:          2026,
  horizonMonths: 12,
  windowMonths:  36,
  lastQuestion:  "Forecast the US economy in 2026",
  charts:        {},
  scenario:      "baseline",
  shocks:        { nfci: 0.0, ff: 0.0 },
  loading:       false,
};

/* ---- UTILS ---- */
function fmt(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  return Number(x).toFixed(digits);
}

function lastNonNull(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return v;
  }
  return null;
}

function parseYear(text) {
  const m = text.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return (y >= 2000 && y <= 2100) ? y : null;
}

function parseHorizon(text) {
  const m = text.match(/horizon\s*[:=]?\s*(\d{1,2})\b/i) ||
            text.match(/\b(\d{1,2})\s*(?:months?)\b/i) ||
            text.match(/\b(\d{1,2})m\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n > 0 && n <= 60) ? n : null;
}

function parseWindow(text) {
  const m = text.match(/window\s*[:=]?\s*(\d{1,3})\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 12 && n <= 240) ? n : null;
}

function parseScenario(text) {
  const t = text.toLowerCase();
  if (t.includes("tariff"))               return "tariff_shock";
  if (t.includes("stagflat"))             return "stagflation";
  if (t.includes("soft land"))            return "soft_landing";
  if (t.includes("credit tight"))         return "credit_tightening";
  if (t.includes("reaccel") || t.includes("re-accel")) return "reacceleration";
  return null;
}

function addBubble(text, who = "assistant", isError = false) {
  const div = document.createElement("div");
  div.className = `bubble ${who}${isError ? " error" : ""}`;
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setPills() {
  knobPills.innerHTML = "";
  const items = [
    { k: "Year",     v: state.year },
    { k: "Horizon",  v: `${state.horizonMonths}m` },
    { k: "Window",   v: `${state.windowMonths}m` },
    { k: "Scenario", v: state.scenario.replaceAll("_", " ") },
    ...(state.shocks.nfci !== 0 ? [{ k: "ΔNFCI", v: state.shocks.nfci.toFixed(2) }] : []),
    ...(state.shocks.ff   !== 0 ? [{ k: "ΔFF",   v: `${state.shocks.ff.toFixed(2)}pp` }] : []),
  ];
  for (const it of items) {
    const p = document.createElement("span");
    p.className = "pillMini";
    p.innerHTML = `<strong>${it.k}:</strong> ${it.v}`;
    knobPills.appendChild(p);
  }
}

function setLoading(on) {
  state.loading = on;
  loadingBanner.classList.toggle("active", on);
  runBtn.disabled  = on;
  sendBtn.disabled = on;
  if (applyLabBtn) applyLabBtn.disabled = on;
}

/* ---- CHARTS ---- */
function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function buildDatasets(series, { showAnchor = false, anchorLabel = "Anchor", colors = {} } = {}) {
  const labels   = series.labels  || [];
  const history  = series.history || [];
  const forecast = series.forecast || [];
  const p10      = series.p10_forecast || null;
  const p90      = series.p90_forecast || null;

  const ds = [];

  ds.push({
    label: "History",
    data: history,
    borderColor: colors.history || "#64748b",
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.3,
    spanGaps: true,
  });

  if (p10 && p90) {
    ds.push({
      label: "P10",
      data: p10,
      borderColor: colors.p10 || "rgba(148,163,184,0.4)",
      backgroundColor: "transparent",
      borderWidth: 1,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true,
      borderDash: [2, 4],
    });
    ds.push({
      label: "P90 (uncertainty band)",
      data: p90,
      borderColor: colors.p10 || "rgba(148,163,184,0.4)",
      backgroundColor: colors.band || "rgba(148,163,184,0.08)",
      borderWidth: 1,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true,
      fill: "-1",
      borderDash: [2, 4],
    });
  }

  ds.push({
    label: "Forecast (mean)",
    data: forecast,
    borderColor: colors.main || "#3b82f6",
    backgroundColor: "transparent",
    borderWidth: 2.5,
    borderDash: [7, 4],
    pointRadius: 0,
    tension: 0.3,
    spanGaps: true,
  });

  if (showAnchor && series.anchor !== null && series.anchor !== undefined) {
    const a = Number(series.anchor);
    ds.push({
      label: anchorLabel,
      data: labels.map(() => a),
      borderColor: "rgba(100,116,139,0.4)",
      backgroundColor: "transparent",
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
    });
  }

  return { labels, datasets: ds };
}

function renderChart(canvasId, series, opts = {}) {
  if (!series || !Array.isArray(series.labels)) return;
  destroyChart(canvasId);

  const ctx = $(canvasId)?.getContext("2d");
  if (!ctx) return;

  const { labels, datasets } = buildDatasets(series, opts);

  state.charts[canvasId] = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 60,
      animation: { duration: 500, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 16,
            color: "#64748b",
            font: { size: 11 },
            padding: 12,
          },
        },
        tooltip: {
          enabled: true,
          backgroundColor: "#1e2d42",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "#2d3f58",
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v === null || v === undefined) return null;
              return ` ${ctx.dataset.label}: ${v.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 7,
            color: "#475569",
            font: { size: 10 },
            maxRotation: 0,
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: {
            color: "#475569",
            font: { size: 10 },
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

/* ---- KPI UPDATE ---- */
function updateKpi(cfg, series) {
  if (!series) return;

  const latest   = series.latest;
  const endFc    = lastNonNull(series.forecast);
  const delta    = (endFc !== null && latest !== null) ? endFc - latest : null;
  const suf      = cfg.isPct ? "%" : "";

  // Value
  const valEl = $(cfg.valEl);
  if (valEl) valEl.textContent = latest !== null ? `${fmt(latest, 2)}${suf}` : "—";

  // Direction arrow + color
  const chgEl = $(cfg.chgEl);
  if (chgEl) {
    if (delta === null || !Number.isFinite(delta)) {
      chgEl.textContent = "—";
      chgEl.className   = "kpiChange flat";
    } else {
      const up    = delta > 0.005;
      const down  = delta < -0.005;
      const arrow = up ? "↑" : down ? "↓" : "→";
      chgEl.textContent = `${arrow} ${fmt(Math.abs(delta), 2)}${suf} forecast`;

      // "good" direction is context-specific
      if      (!up && !down)          chgEl.className = "kpiChange flat";
      else if ((cfg.dirGoodDown && down) || (!cfg.dirGoodDown && up))
                                       chgEl.className = "kpiChange down"; // green
      else                             chgEl.className = "kpiChange up";   // red
    }
  }

  // Latest label in chart header
  const latestEl = $(cfg.latestEl);
  if (latestEl) latestEl.textContent = latest !== null ? `${fmt(latest, 2)}${suf}` : "—";
}

/* ---- RECESSION METER ---- */
function updateRecessionMeter(prob) {
  if (prob === null || prob === undefined) return;

  recSection.hidden = false;
  recFill.style.width = `${Math.min(100, prob)}%`;
  recPct.textContent  = `${prob}%`;

  let color, label;
  if      (prob < 20) { color = "#10b981"; label = "Low risk"; }
  else if (prob < 40) { color = "#eab308"; label = "Moderate risk"; }
  else if (prob < 60) { color = "#f97316"; label = "Elevated risk"; }
  else                { color = "#ef4444"; label = "High risk"; }

  recFill.style.backgroundColor = color;
  recPct.style.color            = color;
  recDesc.textContent           = label;
}

/* ---- NARRATIVE ---- */
function renderNarrative(text, isAI) {
  narrativeSrc.textContent = isAI ? "✦ AI-generated (GPT-4o)" : "Template analysis";

  if (typeof marked !== "undefined" && marked.parse) {
    narrativeText.innerHTML = marked.parse(text, { breaks: true });
  } else {
    // Fallback: simple pre
    const pre = document.createElement("pre");
    pre.style.cssText = "white-space:pre-wrap;font-size:13px;line-height:1.65;margin:0";
    pre.textContent = text;
    narrativeText.innerHTML = "";
    narrativeText.appendChild(pre);
  }
}

/* ---- SHOW RESULTS ---- */
function showResults(raw) {
  results.hidden = false;
  updatedLabel.textContent = raw.updated || "—";

  const S = raw.series || {};

  // FCI can come as "fci" or legacy "financialConditions"
  const fciSeries = S.fci || S.financialConditions || S.nfci;

  // Map API response keys to our series map
  const seriesLookup = {
    cpi:                S.cpi,
    unemployment:       S.unemployment,
    fedFunds:           S.fedFunds,
    gdp:                S.gdp,
    yieldCurve:         S.yieldCurve,
    fci:                fciSeries,
    industrialProduction: S.industrialProduction,
    consumerSentiment:  S.consumerSentiment,
  };

  for (const cfg of SERIES_MAP) {
    const series = seriesLookup[cfg.apiKey];
    if (!series) continue;
    updateKpi(cfg, series);
    renderChart(cfg.chartId, series, {
      showAnchor:  cfg.showAnchor,
      anchorLabel: cfg.anchorLabel || "Anchor",
      colors:      cfg.colors,
    });
  }

  updateRecessionMeter(raw.recessionProbability ?? null);
  renderNarrative(raw.narrative || "—", raw.aiNarrative || false);
}

/* ---- API CALL ---- */
async function runForecast(questionText) {
  setLoading(true);

  const payload = {
    question:      questionText || state.lastQuestion,
    year:          state.year,
    horizonMonths: state.horizonMonths,
    windowMonths:  state.windowMonths,
    scenario:      state.scenario,
    shocks:        { nfci: state.shocks.nfci, ff: state.shocks.ff },
  };

  const scenLabel = state.scenario.replaceAll("_", " ");
  addBubble(
    `Running ${scenLabel} · ${state.horizonMonths}m horizon · ${state.windowMonths}m window` +
    (state.shocks.nfci !== 0 ? ` · ΔNFCI ${state.shocks.nfci.toFixed(2)}` : "") +
    (state.shocks.ff   !== 0 ? ` · ΔFF ${state.shocks.ff.toFixed(2)}pp`   : ""),
    "assistant"
  );

  try {
    const res = await fetch(`${API_URL}/forecast`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Forecast failed (${res.status}). ${t}`);
    }

    const raw = await res.json();
    showResults(raw);
    addBubble("Done. Scroll down for charts and analysis.", "assistant");
  } catch (e) {
    console.error(e);
    addBubble(`Error: ${e.message || "Forecast failed. Check console."}`, "assistant", true);
  } finally {
    setLoading(false);
  }
}

/* ---- CHAT HANDLER ---- */
function handleUserMessage(text) {
  const msg = text.trim();
  if (!msg) return;

  addBubble(msg, "user");

  // Parse parameters silently — no prompting
  const y = parseYear(msg);
  const h = parseHorizon(msg);
  const w = parseWindow(msg);
  const s = parseScenario(msg);

  if (y) state.year          = y;
  if (h) state.horizonMonths = h;
  if (w) state.windowMonths  = w;
  if (s) {
    state.scenario = s;
    if (scenarioSelect) scenarioSelect.value = s;
  }

  state.lastQuestion = msg;
  setPills();

  runForecast(msg).catch(console.error);
}

/* ---- RESET ---- */
function resetAll() {
  Object.keys(state.charts).forEach((id) => {
    state.charts[id]?.destroy();
    delete state.charts[id];
  });

  state.year          = 2026;
  state.horizonMonths = 12;
  state.windowMonths  = 36;
  state.lastQuestion  = "Forecast the US economy in 2026";
  state.scenario      = "baseline";
  state.shocks.nfci   = 0;
  state.shocks.ff     = 0;

  if (scenarioSelect) scenarioSelect.value = "baseline";
  if (nfciShock)  { nfciShock.value  = "0"; nfciShockVal.textContent = "0.00"; }
  if (ffShock)    { ffShock.value    = "0"; ffShockVal.textContent   = "0.00"; }

  results.hidden    = true;
  recSection.hidden = true;
  updatedLabel.textContent = "—";
  narrativeText.innerHTML  = "";
  narrativeSrc.textContent = "—";
  knobPills.innerHTML      = "";
  loadingBanner.classList.remove("active");

  chatBox.innerHTML = `<div class="bubble assistant">
    Reset. Click <strong>Run Forecast</strong> or type a request.
  </div>`;

  setPills();
}

/* ---- SCENARIO LAB WIRING ---- */
function wireLab() {
  const syncSliders = () => {
    nfciShockVal.textContent = Number(nfciShock.value).toFixed(2);
    ffShockVal.textContent   = Number(ffShock.value).toFixed(2);
  };
  syncSliders();

  scenarioSelect.addEventListener("change", () => {
    state.scenario = scenarioSelect.value;
    setPills();
  });

  nfciShock.addEventListener("input", () => {
    state.shocks.nfci = Number(nfciShock.value);
    syncSliders();
    setPills();
  });

  ffShock.addEventListener("input", () => {
    state.shocks.ff = Number(ffShock.value);
    syncSliders();
    setPills();
  });

  applyLabBtn.addEventListener("click", () => {
    runForecast(state.lastQuestion).catch(console.error);
  });
}

/* ---- BOOT ---- */
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
    if (e.key === "Enter" && !state.loading) {
      handleUserMessage(chatInput.value);
      chatInput.value = "";
    }
  });

  resetBtn.addEventListener("click", resetAll);
}

wire();

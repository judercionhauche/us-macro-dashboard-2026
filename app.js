/* =========================
   CONFIG
========================= */

// Your Cloudflare Worker base URL
const API_URL = "https://us-econ-forecast-worker.judercionhauche.workers.dev";

// Expected endpoints:
// - GET  /meta     (optional) -> { availableYears: [...], maxHorizonMonths, defaultWindowMonths }
// - POST /forecast            -> { updated, series:{...}, narrative }
// If /meta doesn't exist, we fallback safely.


/* =========================
   DOM
========================= */
const el = {
  thread: document.getElementById("thread"),
  userInput: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  status: document.getElementById("statusLine"),
  updatedValue: document.getElementById("updatedValue"),

  contextPills: document.getElementById("contextPills"),
  ctxYear: document.getElementById("ctxYear"),
  ctxHorizon: document.getElementById("ctxHorizon"),
  ctxWindow: document.getElementById("ctxWindow"),

  results: document.getElementById("results"),
  resetBtn: document.getElementById("resetBtn"),


  // KPI
  kpiCpi: document.getElementById("kpiCpi"),
  kpiUnemp: document.getElementById("kpiUnemp"),
  kpiFed: document.getElementById("kpiFed"),
  kpiIp: document.getElementById("kpiIp"),
  kpiCpiSub: document.getElementById("kpiCpiSub"),
  kpiUnempSub: document.getElementById("kpiUnempSub"),
  kpiFedSub: document.getElementById("kpiFedSub"),
  kpiIpSub: document.getElementById("kpiIpSub"),

  // chart subs
  subCpi: document.getElementById("subCpi"),
  subUnemp: document.getElementById("subUnemp"),
  subFed: document.getElementById("subFed"),
  subIp: document.getElementById("subIp"),

  narrativeBox: document.getElementById("narrativeBox"),

  canvCpi: document.getElementById("chartCpi"),
  canvUnemp: document.getElementById("chartUnemp"),
  canvFed: document.getElementById("chartFed"),
  canvIp: document.getElementById("chartIp"),
};

if (!el.thread || !el.userInput || !el.sendBtn) {
  console.warn("Missing conversation DOM elements. Check your HTML ids.");
}


/* =========================
   STATE
========================= */
const state = {
  // Optional meta
  availableYears: null,
  maxHorizonMonths: 24,
  defaultWindowMonths: 36,

  // conversation-collected parameters
  year: null,
  horizonMonths: null,
  windowMonths: null,

  // last user intent (worker needs question)
  lastQuestion: null,

  // flow
  awaiting: null, // "year" | "horizon" | "window" | null

  charts: {
    cpi: null,
    unemp: null,
    fed: null,
    ip: null
  }
};


/* =========================
   SMALL CSS INJECT (tight, nerdy, clean)
========================= */
(function injectNarrativeCSS() {
  const css = `
    .narrative-prose {
      line-height: 1.45;
      font-size: 0.96rem;
    }
    .narrative-prose h4{
      margin: 0.35rem 0 0.25rem;
      font-size: 1.02rem;
      font-weight: 800;
    }
    .narrative-prose h5{
      margin: 0.55rem 0 0.25rem;
      font-size: 0.98rem;
      font-weight: 750;
    }
    .narrative-prose p{
      margin: 0.18rem 0;
      line-height: 1.5;
    }
    .narrative-prose ul{
      margin: 0.2rem 0 0.35rem 1.05rem;
      padding: 0;
    }
    .narrative-prose li{
      margin: 0.14rem 0;
      line-height: 1.45;
    }
    .narrative-prose .nar-note{
      margin: 0.45rem 0;
      padding: 0.55rem 0.7rem;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 14px;
      background: rgba(255,255,255,0.55);
    }
    .narrative-prose .nar-divider{
      height: 1px;
      opacity: 0.25;
      margin: 0.65rem 0;
      background: rgba(0,0,0,0.12);
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();


/* =========================
   UTIL
========================= */
function addMsg(role, text){
  const row = document.createElement("div");
  row.className = `msg ${role === "you" ? "you" : "bot"}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "you" ? "You" : "Assistant";

  const content = document.createElement("div");
  content.textContent = text;

  bubble.appendChild(label);
  bubble.appendChild(content);
  row.appendChild(bubble);
  el.thread.appendChild(row);

  el.thread.scrollTop = el.thread.scrollHeight;
  el.resetBtn?.addEventListener("click", resetApp);
  el.userInput?.focus();

}

function setStatus(msg){
  if (el.status) el.status.textContent = msg || "";
}

function ensureMetaFallback(){
  if (!state.availableYears) state.availableYears = [2024, 2025, 2026];
}

function showContextPillsIfAny(){
  const hasAny = Boolean(state.year || state.horizonMonths || state.windowMonths);
  if (!el.contextPills) return;

  if (!hasAny){
    el.contextPills.classList.add("hidden");
    return;
  }

  el.contextPills.classList.remove("hidden");
  if (el.ctxYear) el.ctxYear.textContent = state.year ?? "—";
  if (el.ctxHorizon) el.ctxHorizon.textContent = state.horizonMonths ? `${state.horizonMonths} months` : "—";
  if (el.ctxWindow) el.ctxWindow.textContent = state.windowMonths ? `Last ${state.windowMonths} months` : "—";
}

function parseYear(text){
  const m = String(text).match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function parseMonths(text){
  const lower = String(text).toLowerCase();

  const ym = lower.match(/(\d+)\s*(year|years|yr|yrs)\b/);
  if (ym) return Number(ym[1]) * 12;

  const mm = lower.match(/(\d+)\s*(month|months|mo|mos)\b/);
  if (mm) return Number(mm[1]);

  const bare = lower.match(/^\s*(\d+)\s*$/);
  if (bare) return Number(bare[1]);

  return null;
}

function parseHorizon(text){
  const lower = String(text).toLowerCase();
  if (/(horizon|next|forecast|ahead)/i.test(lower)) return parseMonths(lower);
  return null;
}

function parseWindow(text){
  const lower = String(text).toLowerCase();
  if (/(window|last|past|lookback|history)/i.test(lower)) return parseMonths(lower);
  return null;
}

function formatMaybePct(val){
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${Number(val).toFixed(2)}%`;
}
function formatMaybeIndex(val){
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${Number(val).toFixed(2)}`;
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function scrollToResults(){
  const target = document.getElementById("results");
  if (!target) return;

  // ensure it's visible before scrolling
  target.classList.remove("hidden");

  target.scrollIntoView({ behavior: "smooth", block: "start" });

  // tiny offset for sticky-ish headers / comfort
  window.scrollBy({ top: -10, left: 0, behavior: "smooth" });
}
if (el.results) el.results.classList.remove("hidden");
scrollToResults();


/* =========================
   NARRATIVE RENDER (safe HTML, no marked, no stack overflow)
========================= */
function renderNarrativeNice(text){
  if (!el.narrativeBox) return;

  let raw = (text || "").toString().trim();
  if (!raw){
    el.narrativeBox.classList.add("narrative-prose");
    el.narrativeBox.innerHTML = `<p>No narrative returned.</p>`;
    
    return;
  }

  // Hard cleanup: remove noisy markdown emphasis
  raw = raw
    .replace(/\*\*\*/g, "")
    .replace(/\*\*/g, "")
    .replace(/```+/g, "")
    .replace(/\n{3,}/g, "\n\n");

  const lines = raw.split("\n");
  let html = [];
  let inList = false;

  for (let line of lines){
    const t = line.trim();
    if (!t){
      if (inList){ html.push(`</ul>`); inList = false; }
      continue;
    }

    // dividers
    if (t === "---" || t === "—" || t === "--"){
      if (inList){ html.push(`</ul>`); inList = false; }
      html.push(`<div class="nar-divider"></div>`);
      continue;
    }

    // NOTE lines
    if (/^note[:\s]/i.test(t) || t.startsWith(">")){
      if (inList){ html.push(`</ul>`); inList = false; }
      const noteText = t.replace(/^>\s?/, "");
      html.push(`<div class="nar-note">${escapeHtml(noteText)}</div>`);
      continue;
    }

    // strong section headers (common in your outputs)
    if (/^(executive|starting point|what each|baseline|risks|watch|key|setup)/i.test(t)){
      if (inList){ html.push(`</ul>`); inList = false; }
      html.push(`<h4>${escapeHtml(t)}</h4>`);
      continue;
    }

    // numbered section headers
    if (/^\d+[\)\.]\s+/.test(t)){
      if (inList){ html.push(`</ul>`); inList = false; }
      html.push(`<h5>${escapeHtml(t)}</h5>`);
      continue;
    }

    // bullets
    if (t.startsWith("-") || t.startsWith("•")){
      if (!inList){ html.push(`<ul>`); inList = true; }
      html.push(`<li>${escapeHtml(t.replace(/^[-•]\s*/, ""))}</li>`);
      continue;
    }

    // normal paragraph
    if (inList){ html.push(`</ul>`); inList = false; }
    html.push(`<p>${escapeHtml(t)}</p>`);
  }

  if (inList) html.push(`</ul>`);

  el.narrativeBox.classList.add("narrative-prose");
  el.narrativeBox.innerHTML = html.join("");
  
}


/* =========================
   META (OPTIONAL)
========================= */
async function loadMeta(){
  try{
    const r = await fetch(`${API_URL}/meta`, { method: "GET" });
    if (!r.ok) throw new Error(`meta status ${r.status}`);
    const data = await r.json();

    if (Array.isArray(data.availableYears) && data.availableYears.length){
      state.availableYears = data.availableYears;
    }
    if (Number.isFinite(data.maxHorizonMonths)) state.maxHorizonMonths = data.maxHorizonMonths;
    if (Number.isFinite(data.defaultWindowMonths)) state.defaultWindowMonths = data.defaultWindowMonths;

  } catch (_) {
    ensureMetaFallback();
  }
}


/* =========================
   RESPONSE NORMALIZATION
   Accepts worker variations and maps to:
   series: { cpi, unemployment, fedFunds, industrialProduction }
========================= */
function normalizeWorkerResponse(data){
  const out = {
    updated: data?.updated || data?.data_last_updated || null,
    narrative: data?.narrative || data?.answer || "",
    series: null
  };

  // Preferred shape: data.series
  if (data && data.series) {
    out.series = data.series;
  }

  // Alternative shape: data.charts (from your worker.js earlier)
  if (!out.series && data && data.charts) {
    // map charts -> series style
    const cpiSrc = data.charts.cpi_yoy || data.charts.cpi || null;
    const unSrc  = data.charts.unrate || data.charts.unemployment || null;
    const fedSrc = data.charts.fedfunds || data.charts.fedFunds || null;
    const ipSrc  = data.charts.indpro || data.charts.industrialProduction || null;

    if (cpiSrc && unSrc && fedSrc && ipSrc){
      out.series = {
        cpi: {
          labels: cpiSrc.labels || [],
          history: cpiSrc.history || [],
          forecast: cpiSrc.forecast || [],
          latest: (data.snapshot?.latest?.cpi_yoy ?? null)
        },
        unemployment: {
          labels: unSrc.labels || [],
          history: unSrc.history || [],
          forecast: unSrc.forecast || [],
          latest: (data.snapshot?.latest?.unrate ?? null)
        },
        fedFunds: {
          labels: fedSrc.labels || [],
          history: fedSrc.history || [],
          forecast: fedSrc.forecast || [],
          latest: (data.snapshot?.latest?.fedfunds ?? null)
        },
        industrialProduction: {
          labels: ipSrc.labels || [],
          history: ipSrc.history || [],
          forecast: ipSrc.forecast || [],
          latest: (data.snapshot?.latest?.indpro ?? null)
        }
      };
    }
  }

  // Safety: if series exists but CPI key is cpi_yoy, map it
  if (out.series && !out.series.cpi && out.series.cpi_yoy){
    out.series.cpi = out.series.cpi_yoy;
  }

  return out;
}


/* =========================
   FLOW / CHATGPT STYLE
========================= */
function askForMissing(){
  ensureMetaFallback();

  if (!state.lastQuestion){
    addMsg("bot", `What would you like to forecast? Example: “Give me a forecast for the US economy in 2026.”`);
    return true;
  }

  if (!state.year){
    state.awaiting = "year";
    addMsg("bot", `What year do you want?\nAvailable: ${state.availableYears.join(", ")}`);
    return true;
  }

  if (!state.availableYears.includes(state.year)){
    state.awaiting = "year";
    addMsg("bot", `I don’t have data configured for ${state.year}.\nAvailable: ${state.availableYears.join(", ")}.\nWhich one should I use?`);
    state.year = null;
    showContextPillsIfAny();
    return true;
  }

  if (!state.horizonMonths){
    state.awaiting = "horizon";
    addMsg("bot", `How far ahead should I forecast (horizon in months)?\nExamples: “3 months”, “12 months”.`);
    return true;
  }

  if (state.horizonMonths > state.maxHorizonMonths){
    state.awaiting = "horizon";
    addMsg("bot", `That horizon is too long.\nMax horizon is ${state.maxHorizonMonths} months. Try 3, 6, 12.`);
    state.horizonMonths = null;
    showContextPillsIfAny();
    return true;
  }

  if (!state.windowMonths){
    state.awaiting = "window";
    addMsg("bot", `What lookback window should I use (in months)?\nExamples: “last 36 months”, “past 60 months”.`);
    return true;
  }

  state.awaiting = null;
  return false;
}

async function handleUserTurn(text){
  addMsg("you", text);

  // Only update question if user is not answering a follow-up prompt
  if (!state.awaiting) state.lastQuestion = text.trim();

  // Extract parameters if present
  const y = parseYear(text);
  const hz = parseHorizon(text);
  const win = parseWindow(text);

  if (y) state.year = y;
  if (hz) state.horizonMonths = hz;
  if (win) state.windowMonths = win;

  // If we’re awaiting a specific item, allow bare answers
  if (state.awaiting === "year") {
    const maybeY = parseYear(text);
    if (maybeY) state.year = maybeY;
  }
  if (state.awaiting === "horizon") {
    const maybeH = parseMonths(text);
    if (maybeH) state.horizonMonths = maybeH;
  }
  if (state.awaiting === "window") {
    const maybeW = parseMonths(text);
    if (maybeW) state.windowMonths = maybeW;
  }

  if (!state.windowMonths && /default|standard|normal/i.test(text)) {
    state.windowMonths = state.defaultWindowMonths;
  }

  showContextPillsIfAny();

  const asked = askForMissing();
  if (asked) return;

  await generateForecast();
}


/* =========================
   FORECAST CALL + RENDER
========================= */
async function generateForecast(){
  if (el.results) el.results.classList.add("hidden");

  setStatus("Generating…");
  addMsg("bot", `Got it. Running forecast for ${state.year}, horizon ${state.horizonMonths} months, window ${state.windowMonths} months…`);

  try{
    const payload = {
      question: state.lastQuestion,          // ✅ required by worker
      year: state.year,                      // optional for future
      horizonMonths: state.horizonMonths,
      windowMonths: state.windowMonths
    };

    const r = await fetch(`${API_URL}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok){
      const t = await r.text();
      throw new Error(`Worker error (${r.status}): ${t}`);
    }

    const raw = await r.json();
    const data = normalizeWorkerResponse(raw);

    if (data.updated && el.updatedValue) el.updatedValue.textContent = data.updated;

    const series = data.series || {};
    const required = ["cpi", "unemployment", "fedFunds", "industrialProduction"];
    for (const k of required){
      if (!series[k]) throw new Error(`Worker response missing series: ${k}`);
      if (!Array.isArray(series[k].labels)) throw new Error(`Series ${k} missing labels[]`);
      if (!Array.isArray(series[k].history)) throw new Error(`Series ${k} missing history[]`);
      if (!Array.isArray(series[k].forecast)) throw new Error(`Series ${k} missing forecast[]`);
    }

    if (el.results) el.results.classList.remove("hidden");

    renderKpis(series, data.updated);
    renderAllCharts(series);

    renderNarrativeNice((data.narrative || "").trim());

    setStatus("");
    addMsg("bot", `Done! Want to change horizon/window/year, or ask another macro question?`);

  } catch (err){
    setStatus("");
    addMsg("bot",
      `Something went wrong.\n${String(err.message || err)}\n\nIf this keeps happening, check:\n- Worker route (/forecast)\n- CORS\n- Response shape (series + labels/history/forecast + narrative)`
    );
  }
}

function renderKpis(series, updated){
  const cpi = series.cpi?.latest;
  const un = series.unemployment?.latest;
  const fed = series.fedFunds?.latest;
  const ip = series.industrialProduction?.latest;

  if (el.kpiCpi) el.kpiCpi.textContent = formatMaybePct(cpi);
  if (el.kpiUnemp) el.kpiUnemp.textContent = formatMaybePct(un);
  if (el.kpiFed) el.kpiFed.textContent = formatMaybePct(fed);
  if (el.kpiIp) el.kpiIp.textContent = formatMaybeIndex(ip);

  const stamp = updated || "—";
  if (el.kpiCpiSub) el.kpiCpiSub.textContent = `latest (${stamp})`;
  if (el.kpiUnempSub) el.kpiUnempSub.textContent = `latest (${stamp})`;
  if (el.kpiFedSub) el.kpiFedSub.textContent = `latest (${stamp})`;
  if (el.kpiIpSub) el.kpiIpSub.textContent = `latest (${stamp})`;

  if (el.subCpi) el.subCpi.textContent = `Latest: ${formatMaybePct(cpi)}`;
  if (el.subUnemp) el.subUnemp.textContent = `Latest: ${formatMaybePct(un)}`;
  if (el.subFed) el.subFed.textContent = `Latest: ${formatMaybePct(fed)}`;
  if (el.subIp) el.subIp.textContent = `Latest: ${formatMaybeIndex(ip)}`;
}

function chartConfig(labels, hist, fcst){
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "History",
          data: hist,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0
        },
        {
          label: "Forecast",
          data: fcst,
          borderWidth: 2,
          borderDash: [6, 5],
          tension: 0.25,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: true } },
      scales: { x: { ticks: { maxRotation: 0 } } }
    }
  };
}

function rebuildChart(existing, canvasEl, cfg){
  if (!canvasEl) return existing;
  if (existing) existing.destroy();
  return new Chart(canvasEl, cfg);
}

function renderAllCharts(series){
  const c = series.cpi;
  const u = series.unemployment;
  const f = series.fedFunds;
  const ip = series.industrialProduction;

  state.charts.cpi = rebuildChart(state.charts.cpi, el.canvCpi, chartConfig(c.labels, c.history, c.forecast));
  state.charts.unemp = rebuildChart(state.charts.unemp, el.canvUnemp, chartConfig(u.labels, u.history, u.forecast));
  state.charts.fed = rebuildChart(state.charts.fed, el.canvFed, chartConfig(f.labels, f.history, f.forecast));
  state.charts.ip = rebuildChart(state.charts.ip, el.canvIp, chartConfig(ip.labels, ip.history, ip.forecast));
}


/* =========================
   EVENTS
========================= */
function onSend(){
  const txt = (el.userInput?.value || "").trim();
  if (!txt) return;
  el.userInput.value = "";
  handleUserTurn(txt);
}

el.sendBtn?.addEventListener("click", onSend);
el.userInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onSend();
});

function resetApp(){
  // state reset
  state.year = null;
  state.horizonMonths = null;
  state.windowMonths = null;
  state.lastQuestion = null;
  state.awaiting = null;

  // UI reset
  if (el.status) el.status.textContent = "";
  if (el.updatedValue) el.updatedValue.textContent = "—";
  if (el.userInput) el.userInput.value = "";

  // clear thread
  if (el.thread) el.thread.innerHTML = "";

  // hide context pills + results
  if (el.contextPills) el.contextPills.classList.add("hidden");
  if (el.results) el.results.classList.add("hidden");

  // destroy charts (avoid memory leaks)
  Object.keys(state.charts).forEach(k => {
    if (state.charts[k]) {
      state.charts[k].destroy();
      state.charts[k] = null;
    }
  });

  // re-seed first message
  addMsg("bot",
    `Tell me what you want to forecast.\nExample: “Give me a forecast for the US economy in 2026.”\n\nIf you don’t specify year/horizon/window, I’ll ask.`
  );

  // scroll back up to conversation area
  document.querySelector(".convo-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* =========================
   INIT
========================= */
(async function init(){
  await loadMeta();

  // Hard-hide pills and results at boot (prevents “default showing”)
  if (el.contextPills) el.contextPills.classList.add("hidden");
  if (el.results) el.results.classList.add("hidden");

  // No defaults (per your request)
  state.year = null;
  state.horizonMonths = null;
  state.windowMonths = null;
  state.lastQuestion = null;
  state.awaiting = null;

  showContextPillsIfAny();

  addMsg("bot",
    `Tell me what you want to forecast.\nExample: “Give me a forecast for the US economy in 2026.”\n\nIf you don’t specify year/horizon/window, I’ll ask.`
  );
})();

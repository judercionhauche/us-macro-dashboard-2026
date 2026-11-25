(() => {
"use strict";
const query = new URLSearchParams(location.search);
const publicApi = document.documentElement.dataset.riskApi;
const access = new URLSearchParams(location.hash.slice(1)).get("access") || "";
const replay = document.documentElement.dataset.debate === "replay" ||
  Boolean(publicApi && query.get("watch") === "recording");
const api = (local, hosted) => publicApi ? publicApi + hosted : local;
const requested = replay || publicApi ? "risk" : query.get("view");
const riskLink = document.getElementById("riskViewLink");
const macroLink = document.getElementById("macroViewLink");
for (const [link, view] of [[riskLink, "risk"], [macroLink, "macro"]]) {
  const params = new URLSearchParams(query);
  params.set("view", view);
  if (!replay && !publicApi) link.href = "?" + params;
}
if (requested !== "risk") {
  macroLink.setAttribute("aria-current", "page");
  return;
}
riskLink.setAttribute("aria-current", "page");
document.getElementById("macroDashboard").hidden = true;
document.getElementById("riskLab").hidden = false;
document.title = "S&P 500 Risk Lab";

const el = id => document.getElementById(id);
let study, chart, visibleHistory = [], liveReady = false, historyRequest;
const company = el("company"), cutoff = el("cutoff"), run = el("riskRun");
const status = el("status"), transcript = el("transcript"), conclusion = el("conclusion");
const historyStatus = el("riskHistoryStatus");
const stage = el("riskStage"), progress = el("riskProgress");
const roles = ["Profitability", "Cash Flow & Debt", "Industry", "Filing Narrative", "moderator"];
const mode = el("riskMode");
const pause = el("riskPause"), stop = el("riskStop"), debrief = el("riskDebrief");
const benchmarkSection = el("riskBenchmark");
const benchmarkRequest = fetch("results/risk_benchmark.json", {signal: AbortSignal.timeout(5000)})
  .then(response => response.ok ? response.json() : null)
  .catch(() => null);
let voteChart, audio, controller, paused = false, resumePlayback;
let forecastCharts = [];
const forecastMetrics = {operating_cash_flow:"Operating cash flow", revenue:"Revenue"};
const pct = value => (value * 100).toFixed(1) + "%";

function option(select, value, text = value) {
  select.add(new Option(text, value));
}

function rows() {
  return study.history.filter(row => row.cik === Number(company.value));
}

function updateControls(running = false) {
  company.disabled = !study || running || replay;
  cutoff.disabled = !study || running || replay || mode.value === "today";
  mode.disabled = !study || running;
  run.disabled = !study || running || (!replay && !liveReady);
}

function selectCompany() {
  const previous = cutoff.value;
  cutoff.replaceChildren();
  if (replay) {
    option(cutoff, study.recordings?.demo.cutoff ?? rows().at(-1).cutoff);
  } else {
    for (const row of rows().reverse()) option(cutoff, row.cutoff);
    if ([...cutoff.options].some(item => item.value === previous)) cutoff.value = previous;
  }
  showCase();
}

function setHistoryStatus(message = "") {
  historyStatus.textContent = message;
  historyStatus.hidden = !message;
}

async function loadCurrentHistory(cik) {
  const request = new AbortController();
  historyRequest = request;
  try {
    const response = await fetch(api("/api/current-history", "/history") + "?cik=" + encodeURIComponent(cik), {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)])
    });
    if (!response.ok) throw new Error("Current history is unavailable.");
    const history = await response.json();
    if (!Array.isArray(history) || !history.length) throw new Error("No current history.");
    if (request.signal.aborted) return;
    visibleHistory = history;
    drawHistory(history);
    setHistoryStatus("Using the latest available filings.");
  } catch {
    if (!request.signal.aborted) showHistoricalFallback();
  }
}

function showHistoricalFallback() {
  const asOf = visibleHistory.at(-1)?.cutoff;
  setHistoryStatus("Latest filings are unavailable. Showing historical evidence" + (asOf ? " through " + asOf : "") + ".");
}

function showCase() {
  historyRequest?.abort();
  setHistoryStatus();
  const selected = study.sample.find(row => row.cik === Number(company.value));
  const history = rows().filter(row => row.cutoff <= cutoff.value);
  const last = history.at(-1);
  const today = mode.value === "today";
  const recording = replay ? study.recordings?.[mode.value] : null;
  el("sector").textContent = selected.sector;
  el("outcome").textContent = today ? "The outcome for the coming year is still unknown." : last?.positive == null
    ? "A frozen outcome is unavailable at this cutoff."
    : last.positive ? "Observed outcome: distress event within four quarters."
                    : "Observed outcome: no qualifying distress event within four quarters.";
  if (replay) {
    cutoff.options[0].text = recording?.cutoff ?? (today ? "Recorded Today case" : cutoff.value);
  }
  visibleHistory = recording?.history ?? (today ? rows() : history);
  drawHistory(visibleHistory);
  transcript.replaceChildren();
  stage.hidden = progress.hidden = true;
  conclusion.hidden = debrief.hidden = true;
  el("evidence").hidden = true;
  status.textContent = replay ? "Ready to play the recorded debate."
    : liveReady ? "Ready to run the selected case."
      : publicApi ? "Live debate is unavailable. Browse historical evidence or choose Watch the recording."
        : "Live debate is unavailable here. Browse historical evidence or open the local research server to run a debate.";
  updateControls();
  if (today && !replay) {
    if (liveReady) {
      setHistoryStatus("Loading the latest filings…");
      loadCurrentHistory(company.value);
    } else {
      showHistoricalFallback();
    }
  }
}

function historyChart(canvas, history, futureStart) {
  return new Chart(canvas, {
    type: "line",
    data: {
      labels: history.map(row => row.cutoff),
      datasets: [
        ["Net margin", "net_margin", "#157675"],
        ["Debt / assets", "debt_assets", "#725fa7"],
        ["Operating cash flow margin", "ocf_margin", "#bb661a"]
      ].map(([label, key, borderColor]) => ({
        label, borderColor, data: history.map(row => row[key] == null ? null : row[key] * 100),
        pointRadius: 2
      }))
    },
    plugins: futureStart ? [{
      id: "afterVerdict",
      beforeDraw(instance) {
        const {ctx, chartArea, scales} = instance;
        if (!chartArea) return;
        const left = scales.x.getPixelForValue(futureStart - .5);
        ctx.save();
        ctx.fillStyle = "rgba(46, 138, 121, .15)";
        ctx.fillRect(left, chartArea.top, chartArea.right - left, chartArea.bottom - chartArea.top);
        ctx.restore();
      }
    }] : [],
    options: {responsive:true, maintainAspectRatio:false, scales:{y:{ticks:{callback:v => v + "%"}}}}
  });
}

function drawHistory(history, futureStart) {
  chart?.destroy();
  chart = historyChart(el("history"), history, futureStart);
}

function text(parent, tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function display(event, selectedCase) {
  if (event.type === "start") {
    selectedCase.cutoff = event.cutoff || selectedCase.cutoff;
    status.textContent = (replay ? "Recorded debate generated with " : "Debate running with ") + event.model + ".";
    if (event.history) {
      visibleHistory = event.history;
      drawHistory(visibleHistory);
    }
    el("riskProgress").max = 13;
    stage.replaceChildren();
    for (const role of roles) {
      const card = text(stage, "div", "", "vdAgent");
      card.dataset.role = role;
      text(card, "span", role === "moderator" ? "Moderator" : role, "vdAgentName");
      text(card, "span", "Waiting", "vdAgentPos");
    }
    progress.value = 0;
    stage.hidden = progress.hidden = false;
    const facts = el("facts");
    facts.replaceChildren();
    for (const [id, value] of Object.entries(event.evidence)) {
      text(facts, "dt", "[" + id + "]");
      text(facts, "dd", value);
    }
    if (event.filing_url) {
      const link = text(facts, "a", "Filing source");
      link.href = event.filing_url;
      link.target = "_blank";
      link.rel = "noopener";
    }
    el("evidence").hidden = false;
  } else if (event.type === "turn" || event.type === "narration") {
    const turn = text(transcript, "div", "", "turn");
    const answer = event.response;
    if (answer) {
      progress.value += 1;
      for (const entry of event.tool_calls || []) {
        const result = entry.result;
        const facts = el("facts");
        text(facts, "dt", result.evidence_id ? "[" + result.evidence_id + "] " + entry.tool : entry.tool);
        text(facts, "dd", result.plain_meaning +
          (result.value == null ? "" : " " + (typeof result.value === "string"
            ? result.value : JSON.stringify(result.value))));
      }
    }
    for (const card of stage.children) {
      const speaking = card.dataset.role === event.agent;
      card.classList.toggle("speaking", speaking);
      if (speaking && answer) {
        card.lastElementChild.textContent = (event.round === 1 ? "Opening " : "Vote ") + pct(answer.p);
      }
    }
    const roundLabel = event.round === 1 ? "Opening" : event.round === 2 ? "Rebuttal" : event.round === 3 ? "Final vote" : "Verdict";
    const speaker = event.agent === "moderator" ? "Moderator" : event.agent;
    const heading = answer
      ? speaker + " · " + roundLabel + " · " + pct(answer.p) + " · " + answer.stance
        + (answer.responds_to ? " · responds to " + answer.responds_to : "")
      : event.title;
    text(turn, "strong", heading);
    text(turn, "p", event.spoken, "riskSpeech");
    if (answer) {
      const citations = text(turn, "div", "", "riskCitations");
      for (const id of new Set(answer.claims.flatMap(claim => claim.ids))) {
        text(citations, "span", id.startsWith("[") ? id : "[" + id + "]");
      }
    }
    transcript.scrollTop = transcript.scrollHeight;
  } else if (event.type === "result") {
    const {E, D} = event.result.arms;
    conclusion.replaceChildren();
    text(conclusion, "strong", "Moderator’s deciding vote · " + D.label + " risk · " + pct(D.p));
    text(conclusion, "p", "Independent specialist average: " + pct(E.p) + ".");
    text(conclusion, "p", D.say);
    const comparisonLink = text(conclusion, "button", "See charts and comparison", "btn");
    comparisonLink.type = "button";
    comparisonLink.addEventListener("click", () => debrief.scrollIntoView({block:"start"}));
    conclusion.hidden = false;
    for (const card of stage.children) card.classList.remove("speaking");
    el("outcome").hidden = false;
    if (event.mode === "today") {
      el("outcome").hidden = false;
      el("outcome").textContent = "The outcome for the coming year is still unknown.";
    }
    if (event.observed?.length) {
      drawHistory([...visibleHistory, ...event.observed], visibleHistory.length);
      text(conclusion, "p", "The shaded chart area shows what happened after the cutoff.");
    }
    showBenchmark(selectedCase, D.p);
    showDebrief(event.result);
    showForecasts(selectedCase);
    status.textContent = "Voice debate complete.";
    debrief.scrollIntoView({block:"start"});
  } else if (event.type === "error") {
    throw new Error(event.error);
  }
}

function dollarsInBillions(value) {
  const match = typeof value === "string" && value.match(/^(-?[\d,.]+(?:e[+-]?\d+)?) (?:(trillion|billion|million|thousand) )?USD$/);
  if (!match) return null;
  const units = {trillion:1000, billion:1, million:.001, thousand:.000001};
  const amount = Number(match[1].replaceAll(",", "")) * (units[match[2]] ?? 1e-9);
  return Number.isFinite(amount) ? amount : null;
}

function saveForecastEvidence(run, event) {
  for (const call of event.tool_calls || []) {
    if (!Object.hasOwn(forecastMetrics, call.metric)) continue;
    const {value, evidence_id: evidenceId, plain_meaning: meaning} = call.result;
    if (call.tool === "get_metric" && call.quarters_back === 0) {
      const reported = dollarsInBillions(value);
      if (reported !== null) run.reported.set(call.metric, reported);
    }
    if (call.tool !== "forecast" || run.forecasts.get(call.metric)?.series) continue;
    const series = ["lower_80_range", "median", "upper_80_range"]
      .map(key => Array.isArray(value?.[key]) ? value[key].map(dollarsInBillions) : []);
    if (series.every(values => values.length === 4 && values.every(Number.isFinite))) {
      run.forecasts.set(call.metric, {series, evidenceId, shortfall:value.share_below_half});
    } else {
      run.forecasts.set(call.metric, {meaning});
    }
  }
}

function forecastFigure(parent, metric, projection, run) {
  const name = forecastMetrics[metric];
  const figure = text(parent, "figure", "");
  text(figure, "h4", name);
  const canvas = text(text(figure, "div", "", "chart"), "canvas", "");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", name + " forecast for four quarters with an 80% model range");
  const [lower, median, upper] = projection.series;
  const observed = run.reported.get(metric);
  const labels = ["Q1 ahead", "Q2 ahead", "Q3 ahead", "Q4 ahead"];
  const withReportedSlot = values => observed === undefined ? values : [null, ...values];
  const datasets = [
    {label:"Lower bound", data:withReportedSlot(lower), borderWidth:0, pointRadius:0},
    {label:"Middle 80% of model forecasts", data:withReportedSlot(upper), borderWidth:0, pointRadius:0,
      backgroundColor:"rgba(21, 118, 117, .18)", fill:"-1"},
    {label:"Forecast median", data:withReportedSlot(median), borderColor:"#157675",
      backgroundColor:"#157675", borderDash:[5, 3], pointRadius:3}
  ];
  if (observed !== undefined) {
    labels.unshift("Latest reported");
    datasets.push({label:"Reported value", data:[observed, null, null, null, null],
      borderColor:"#373c64", backgroundColor:"#373c64", pointRadius:5});
  }
  forecastCharts.push(new Chart(canvas, {
    type:"line",
    data:{labels, datasets},
    options:{responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{filter:item => item.datasetIndex !== 0}}},
      scales:{y:{title:{display:true, text:run.mode === "research" ? "Scaled USD, billions" : "USD, billions"}}}}
  }));
  const numbers = new Intl.NumberFormat("en-US", {maximumFractionDigits:3});
  const unit = run.mode === "research" ? "scaled USD billions" : "USD billions";
  text(figure, "figcaption", `Quarter 4 median: ${numbers.format(median[3])} ${unit}. Middle 80%: ${numbers.format(lower[3])} to ${numbers.format(upper[3])}.` +
    (projection.evidenceId ? ` [${projection.evidenceId}]` : ""), "muted small");
  if (projection.shortfall) {
    text(figure, "p", `${projection.shortfall} of modeled paths put the next four quarters’ total cash flow below half the previous four quarters’ total.`, "small");
  }
}

function showForecasts(run) {
  const section = el("riskForecasts");
  forecastCharts.forEach(chart => chart.destroy());
  forecastCharts = [];
  section.replaceChildren();
  const heading = text(section, "h3", "Forecasts from this debate");
  heading.id = "riskForecastTitle";
  const available = [...run.forecasts].filter(([, projection]) => projection.series);
  const unavailable = [...run.forecasts].filter(([, projection]) => !projection.series);
  if (!run.forecasts.size) text(section, "p", "The panel did not request a four-quarter forecast.");
  for (const [metric, projection] of unavailable) {
    text(section, "p", forecastMetrics[metric] + ": " + projection.meaning);
  }
  const grid = text(section, "div", "", "riskForecastGrid");
  for (const [metric, projection] of available) forecastFigure(grid, metric, projection, run);
  if (!available.length && visibleHistory.length) {
    const figure = text(grid, "figure", "");
    text(figure, "h4", "Financial signals available at the cutoff");
    const canvas = text(text(figure, "div", "", "chart"), "canvas", "");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Most recent reported net margin, debt to assets, and operating cash flow margin");
    forecastCharts.push(historyChart(canvas, visibleHistory.slice(-8)));
  }
}

function auditedCase(run) {
  return run.mode !== "today" && run.cutoff === run.benchmark?.cutoff
    ? run.benchmark.cases[String(run.cik)] : null;
}

function showBenchmark(run, vote) {
  benchmarkSection.replaceChildren();
  const heading = text(benchmarkSection, "h3", "How does this compare with human analysts?");
  heading.id = "riskBenchmarkTitle";
  const {benchmark} = run;
  if (!benchmark) {
    text(benchmarkSection, "p", "The historical analyst benchmark could not load.");
    return;
  }
  const match = auditedCase(run);
  const values = text(benchmarkSection, "dl", "", "riskBenchmarkValues");
  function item(label, value) {
    const field = text(values, "div", "");
    text(field, "dt", label);
    text(field, "dd", value);
  }
  item("AI moderator · this debate", pct(vote));
  item("Published Fitch issuer grade", match?.grade ?? "No matched grade");
  item("Observed study outcome", match ? (match.event ? "Financial trouble observed" : "No qualifying event")
    : run.mode === "today" ? "Pending" : "See the case outcome below");
  if (match) el("outcome").hidden = true;
  if (match?.grade) {
    text(benchmarkSection, "p",
      `${run.ticker} had a ${match.grade} issuer grade from a rating action dated ${match.action_date}, in the ${benchmark.archive_date} archive. Fitch grades credit default risk. The AI vote covers a broader set of financial setbacks.`);
  } else {
    text(benchmarkSection, "p", run.mode === "today"
      ? "Today's run has a different cutoff from the historical Fitch test. Its four-quarter outcome is still pending."
      : `The Fitch test uses ${benchmark.cutoff}. This company and cutoff have no usable matching grade in that test.`);
  }
  if (match?.corrected) {
    text(benchmarkSection, "p", "The outcome shown here incorporates the audit of the original dividend-cut flag.");
  }
  const details = text(benchmarkSection, "details", "");
  details.open = true;
  text(details, "summary", "Historical ranking comparison");
  text(details, "p",
    `Across ${benchmark.companies} companies with comparable Fitch grades and ${benchmark.events} observed events, Fitch scored ${benchmark.fitch_auroc.toFixed(3)} and the AI debate scored ${benchmark.debate_auroc.toFixed(3)} on AUROC. These scores measure how well the earlier methods ranked companies by risk. The AI runs used only financial numbers.`);
  const image = text(details, "img", "");
  image.src = "results/human_benchmark/ratings_vs_ai.png";
  image.alt = "Risk ranking with 95% intervals for Fitch, a single AI analyst, three independent AI analysts, and debate.";
  image.loading = "lazy";
  const sources = text(details, "p", "");
  const evidenceLink = text(sources, "a", "Open the study results and matching audit");
  evidenceLink.href = "https://github.com/judercionhauche/us-macro-dashboard-2026/tree/sp500-risk/results/human_benchmark";
}

function showDebrief(result) {
  const {E, D} = result.arms;
  const movement = (D.p - E.p) * 100;
  const checks = Object.values(result.referee).flat();
  const supported = checks.filter(check => check === "supported").length;
  const ballots = {High:0, Medium:0, Low:0};
  for (const {p} of Object.values(result.round_two)) ballots[p >= .5 ? "High" : p >= .2 ? "Medium" : "Low"]++;
  const comparison = Math.abs(movement) < 0.05 ? "matched the opening specialist average"
    : "was " + Math.abs(movement).toFixed(1) + " percentage points " +
      (movement > 0 ? "above" : "below") + " the opening specialist average";
  el("riskDebriefSummary").textContent =
    "The moderator’s " + pct(D.p) + " " + D.label.toLowerCase() + "-risk vote " +
    comparison + ". The evidence check supported " + supported + " of " + checks.length +
    " opening claims. Analyst votes: " + ballots.High + " high, " + ballots.Medium +
    " medium, " + ballots.Low + " low.";
  const timing = el("riskSpeakingTime");
  timing.replaceChildren();
  const seconds = result.speech_seconds || {};
  const max = Math.max(1, ...roles.slice(0,4).map(role => seconds[role] || 0));
  for (const role of roles.slice(0,4)) {
    const line = text(timing, "label", role + " · " + (seconds[role] || 0).toFixed(0) + " sec");
    const meter = text(line, "progress", "");
    meter.max = max;
    meter.value = seconds[role] || 0;
  }
  const disagreements = el("riskDisagreements");
  disagreements.replaceChildren();
  if (D.open_disagreements) {
    text(disagreements, "h3", "Unresolved points");
    text(disagreements, "p", D.open_disagreements);
  }
  debrief.hidden = false;
  if (voteChart) voteChart.destroy();
  voteChart = new Chart(el("riskVoteChart"), {
    type: "bar",
    data: {
      labels: roles.map(role => role === "moderator" ? "Moderator" : role),
      datasets: [
        {label:"Opening estimate", backgroundColor:"#5e7790",
         data:roles.map(role => result.round_one[role] ? result.round_one[role].p * 100 : null)},
        {label:"Rebuttal estimate", backgroundColor:"#9f6a31",
         data:roles.map(role => result.rebuttals?.[role] ? result.rebuttals[role].p * 100 : null),
         hidden:!result.rebuttals},
        {label:"Final specialist vote", backgroundColor:"#157675",
         data:roles.map(role => result.round_two[role] ? result.round_two[role].p * 100 : null)},
        {label:"Moderator verdict", backgroundColor:"#373c64",
         data:roles.map(role => role === "moderator" ? D.p * 100 : null)}
      ]
    },
    options:{responsive:true, maintainAspectRatio:false, scales:{y:{min:0, max:100,
      ticks:{callback:value => value + "%"}}}}
  });
}

function browserVoice(event, signal) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error(event.audio_error || "No audio is available for this turn."));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(event.spoken);
    const index = roles.indexOf(event.agent);
    const voices = speechSynthesis.getVoices().filter(voice => /^en/i.test(voice.lang));
    if (voices.length) utterance.voice = voices[index % voices.length];
    utterance.pitch = [1, 1.15, .88, 1.05, .8][index];
    utterance.rate = [1, .97, .92, 1.05, .95][index];
    let timer, elapsed = 0;
    const ended = () => finish();
    const fail = message => finish(new Error(message));
    const aborted = () => { speechSynthesis.cancel(); finish(signal.reason); };
    const finish = error => {
      clearInterval(timer);
      signal.removeEventListener("abort", aborted);
      utterance.onend = utterance.onerror = null;
      if (error) reject(error); else resolve();
    };
    utterance.onend = ended;
    utterance.onerror = () => fail(event.audio_error || "The browser could not play this speaker.");
    timer = setInterval(() => {
      if (paused) return;
      elapsed += 1000;
      if (elapsed >= Math.max(30000, event.spoken.length * 160)) {
        finish(new Error("Browser voice did not finish. Check audio output and try again."));
        speechSynthesis.cancel();
      }
    }, 1000);
    signal.addEventListener("abort", aborted, {once:true});
    speechSynthesis.speak(utterance);
  });
}

async function playTurn(event, signal) {
  signal.throwIfAborted();
  if (paused) await new Promise(resolve => { resumePlayback = resolve; });
  signal.throwIfAborted();
  display(event);
  const speaker = event.agent === "moderator" ? "Moderator" : event.agent + " analyst";
  status.textContent = speaker + " speaking";
  if ((event.audio || event.audio_url) && audio) {
    let bytes;
    if (event.audio_url) {
      const response = await fetch(event.audio_url, {signal});
      if (!response.ok) throw new Error("Could not load this speaker’s recording.");
      bytes = await response.arrayBuffer();
    } else {
      bytes = Uint8Array.from(atob(event.audio), character => character.charCodeAt(0)).buffer;
    }
    const clip = await audio.decodeAudioData(bytes).catch(() => null);
    signal.throwIfAborted();
    if (clip) {
      await new Promise((resolve, reject) => {
        const source = audio.createBufferSource();
        source.buffer = clip;
        source.connect(audio.destination);
        const abort = () => { source.stop(); reject(signal.reason); };
        source.onended = () => {
          signal.removeEventListener("abort", abort);
          source.disconnect();
          resolve();
        };
        signal.addEventListener("abort", abort, {once:true});
        source.start();
      });
      return;
    }
  }
  status.textContent = speaker + " speaking (browser voice)";
  await browserVoice(event, signal);
}

pause.addEventListener("click", () => {
  paused = !paused;
  pause.textContent = paused ? "Resume audio" : "Pause audio";
  if (paused) {
    audio?.suspend().catch(() => {});
    window.speechSynthesis?.pause();
  } else {
    audio?.resume().catch(() => {});
    window.speechSynthesis?.resume();
    resumePlayback?.();
    resumePlayback = undefined;
  }
});
stop.addEventListener("click", () => {
  controller?.abort();
  resumePlayback?.();
  resumePlayback = undefined;
});

async function debate() {
  historyRequest?.abort();
  setHistoryStatus();
  updateControls(true);
  pause.hidden = stop.hidden = false;
  pause.textContent = "Pause audio";
  paused = false;
  controller = new AbortController();
  const signal = controller.signal;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (Audio) {
    try {
      audio = new Audio();
      // Invoke resume from the Start click before awaiting network data.
      audio.resume().catch(() => {});
    } catch {
      audio = undefined;
    }
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  transcript.replaceChildren();
  conclusion.hidden = el("evidence").hidden = stage.hidden = progress.hidden = debrief.hidden = true;
  status.textContent = replay ? "Loading the recorded debate…" : "Preparing cutoff-safe evidence…";
  try {
    const selectedCase = {cik:Number(company.value), ticker:company.selectedOptions[0].text,
      cutoff:cutoff.value, mode:mode.value, benchmark:await benchmarkRequest,
      forecasts:new Map(), reported:new Map()};
    const {cik, cutoff:decisionDate, mode:decisionMode} = selectedCase;
    const response = replay ? await fetch("replay/" + decisionMode + "/events.jsonl", {signal}) : await fetch(api("/api/debate", "/debate"), {
      signal, method:"POST", headers:{"Content-Type":"application/json", ...(publicApi ? {"X-Risk-Access":access} : {"X-Risk-Demo":"local"})},
      body:JSON.stringify({cik, cutoff:decisionDate, mode:decisionMode})
    });
    if (!response.ok) throw new Error(replay ? "Could not load the recording." : (await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "", completed = false;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        // The spoken historical reveal uses the original labels. Show the audited result
        // in the comparison panel when the dividend flag changed that outcome.
        if (event.type === "narration" && event.title === "What happened next" && auditedCase(selectedCase)?.corrected) continue;
        if (event.type === "turn" || event.type === "narration") {
          saveForecastEvidence(selectedCase, event);
          await playTurn(event, signal);
          for (const card of stage.children) card.classList.remove("speaking");
          status.textContent = "Preparing the next turn…";
        } else {
          display(event, selectedCase);
        }
        completed ||= event.type === "result";
      }
    }
    if (!completed) throw new Error("The connection ended before the moderator returned.");
  } catch (error) {
    status.textContent = signal.aborted ? "Debate stopped." : "Debate unavailable. " + error.message;
    controller.abort();
  } finally {
    for (const card of stage.children) card.classList.remove("speaking");
    if (audio) await audio.close().catch(() => {});
    audio = undefined;
    if (paused) window.speechSynthesis?.resume();
    if (window.speechSynthesis) speechSynthesis.cancel();
    pause.hidden = stop.hidden = true;
    updateControls();
  }
}

async function fetchStudy(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error("Could not load study data.");
  const data = await response.json();
  if (!data.sample?.length || !data.history?.length || !data.metrics?.A1) {
    throw new Error("Study data is incomplete.");
  }
  return data;
}

async function init() {
  if (replay) {
    study = await fetchStudy("replay/study.json");
  } else {
    try {
      study = await fetchStudy(api("/api/study", "/study"), {signal: AbortSignal.timeout(4000)});
      liveReady = true;
    } catch {
      study = await fetchStudy("results/risk_study.json");
    }
  }
  const metrics = study.metrics;
  const cards = [
    [study.company_count ?? study.sample.length, "companies sampled"],
    [study.total.toLocaleString(), "frozen observations"],
    [pct(study.positive / study.total), "distress event rate"],
    [metrics.A1.auroc.toFixed(3), "logistic test AUROC"]
  ];
  for (const [value, description] of cards) {
    const card = text(el("summary"), "div", "", "labTile");
    text(card, "strong", value);
    text(card, "span", description);
  }
  el("finding").textContent = "On " + metrics.common_baseline_rows + " shared test observations, " +
    "Altman Z″ reached " + metrics.A0.auroc.toFixed(3) + " AUROC and logistic regression reached " +
    metrics.A1.auroc.toFixed(3) + ". A distress event is a qualifying loss onset, cash-flow collapse, dividend cut, or bankruptcy.";
  const available = new Set(study.history.map(row => row.cik));
  for (const row of study.sample.filter(row => available.has(row.cik)).sort((a,b) => a.ticker.localeCompare(b.ticker))) {
    option(company, row.cik, row.ticker);
  }
  if ([...company.options].some(o => o.text === "AEP")) company.value = "4904";
  if (replay) {
    mode.querySelector('option[value="research"]')?.remove();
    mode.querySelector('option[value="today"]').textContent = "Today · recorded";
    mode.value = query.get("case") === "today" ? "today" : "demo";
    run.textContent = "Play voice debate";
  }
  selectCompany();
  company.addEventListener("change", selectCompany);
  cutoff.addEventListener("change", showCase);
  mode.addEventListener("change", showCase);
  run.addEventListener("click", debate);
}

init().catch(() => {
  status.textContent = replay ? "The recording could not be loaded. Refresh to try again."
    : "Company evidence could not be loaded. Refresh to try again.";
});
})();

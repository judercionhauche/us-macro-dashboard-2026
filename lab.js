/* ============================================================
   AI ECONOMIC POLICY LAB — frontend
   Talks to the worker's /lab/meeting endpoint. All numbers shown come from the
   estimated model; agents only argue and vote. Every view is labelled a simulation.
   ============================================================ */
(() => {
  // ?api= overrides; on this machine (Live Server, file://, or the dev server) use the local
  // worker on :8787, because the deployed worker may not have the Lab routes yet.
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname);
  const LAB_API = new URLSearchParams(location.search).get("api") || (IS_LOCAL ? (location.port === "8787" ? location.origin : "http://localhost:8787") : API_URL);
  const el = (id) => document.getElementById(id);
  const labCharts = {};
  let last = null; // { model, meeting }

  const NAMES = {};
  const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(d)}%`);
  const bp = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)} bp`;
  const moveLabel = (k) => (Number(k) === 0 ? "Hold" : `${Number(k) > 0 ? "Raise" : "Cut"} ${Math.abs(Number(k))} bp`);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const VAR_CFG = [
    { key: "infl", canvas: "labInflChart", title: "Core PCE inflation", color: "#0D9488", band: "rgba(13,148,136,0.13)", anchor: 2 },
    { key: "u",    canvas: "labUChart",    title: "Unemployment",       color: "#0D9488", band: "rgba(13,148,136,0.13)" },
    { key: "ffr",  canvas: "labFfChart",   title: "Fed funds (effective)", color: "#0D9488", band: "rgba(13,148,136,0.13)" },
    { key: "gdp",  canvas: "labGdpChart",  title: "Real GDP growth (bridge)", color: "#0D9488", band: "rgba(13,148,136,0.13)" },
  ];

  function setStep(n) {
    document.querySelectorAll("#labSteps li").forEach((li, i) => li.classList.toggle("done", i < n));
  }

  async function runMeeting() {
    const btn = el("labRunBtn");
    btn.disabled = true;
    el("labStatus").className = "labStatus";
    el("labStatus").textContent = "Loading data, estimating the model and running the committee… (live AI meetings take 30–90 s)";
    setStep(1);
    try {
      const res = await fetch(`${LAB_API}/lab/meeting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asOf: el("labAsOf").value || null, holdMonths: Number(el("labHold").value), mode: el("labMode").value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      last = data;
      window.PolicyLab.show(data, { scroll: true });
    } catch (e) {
      el("labStatus").className = "labStatus error";
      el("labStatus").textContent = `Could not run the meeting: ${e.message}. If you are running locally, start the worker (cd worker && npx wrangler dev) and open this page with ?api=http://localhost:8787`;
      setStep(0);
    } finally {
      btn.disabled = false;
    }
  }

  function renderSources(snap, err) {
    const box = el("labSources"); if (!box) return;
    if (!snap) { box.innerHTML = `<p class="muted small">Data snapshot unavailable${err ? `: ${esc(err)}` : ""}. The meeting used the model's data only.</p>`; return; }
    const rows = snap.derived.map((d) => {
      const r = snap.raw.indicators.find((x) => x.id === d.id) || snap.raw.labor.find((x) => x.id === d.id);
      return `<tr><td>${esc(d.label)}</td><td>${esc(d.value)}</td><td>${esc(d.observationDate)}</td><td class="small">${r ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(d.from)}</a>` : esc(d.from)}</td></tr>`;
    }).join("");
    const st = snap.raw.statement;
    box.innerHTML = `<p class="small">${snap.mode === "historical" ? `Only information published before <strong>${esc(snap.cutoff)}</strong>; macro values are as first published (ALFRED vintages).` : "Latest published values."} BLS labor values are cross-checked against FRED/ALFRED.</p>
      <table class="labTable small"><thead><tr><th>Indicator</th><th>Value</th><th>Observation</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small"><strong>FOMC statement used:</strong> ${st ? `<a href="${esc(st.url)}" target="_blank" rel="noopener">${esc(st.title)}</a> — “${esc(st.decisionParagraph)}”` : "none found before the cutoff"}</p>
      <p class="small"><strong>Board speeches (45 days before the cutoff):</strong></p>
      <ul class="small">${snap.raw.speeches.map((x) => `<li>${esc(x.date)} · ${esc(x.speaker)} · <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.textAvailable ? "" : " <span class=\"muted\">(text unavailable)</span>"}</li>`).join("") || "<li class=\"muted\">none</li>"}</ul>
      ${snap.issues.length ? `<p class="small"><strong>Data notes:</strong></p><ul class="small muted">${snap.issues.map((i) => `<li>[${esc(i.kind)}] ${esc(i.source)}: ${esc(i.message)}</li>`).join("")}</ul>` : ""}`;
  }

  function render({ model, meeting, snapshot, snapshotError }) {
    renderSources(snapshot, snapshotError);
    meeting.members.forEach((m) => (NAMES[m.id] = m.name));
    el("labBody").hidden = false;
    el("labStatus").textContent = `${meeting.mode === "live" ? "Live AI mode — " : ""}${meeting.modeNote}`
      + (meeting.usage ? ` Used ${meeting.usage.calls} model calls (${meeting.usage.input.toLocaleString()} input / ${meeting.usage.output.toLocaleString()} output tokens).` : "");

    renderConditions(model);
    renderDecision(model, meeting);
    renderOutlookSummary(model, meeting);
    renderMembers(meeting);
    renderTranscript(meeting);
    renderEvidence(model, meeting);
    const sel = el("labCompare");
    sel.value = meeting.decision.scenarioKey;
    renderCharts(model, sel.value);
    renderScenarioTable(model, meeting);
    renderDebatePanel(meeting);
  }

  function renderConditions(model) {
    const c = model.conditions;
    const tiles = [
      ["Policy rate (target midpoint)", pct(c.policyRate, 3)],
      ["Core PCE inflation", `${pct(c.coreInflation)} <span class="muted">vs 2% target</span>`],
      ["Unemployment", `${pct(c.unemployment)} <span class="muted">natural ≈ ${pct(c.naturalUnemployment)}</span>`],
      ["Real GDP growth", `${pct(c.gdpGrowth)} <span class="muted">${esc(c.gdpQuarter || "")}</span>`],
    ];
    el("labConditions").innerHTML = tiles.map(([k, v]) => `<div class="labTile"><div class="labTileK">${k}</div><div class="labTileV">${v}</div></div>`).join("")
      + `<div class="labNote muted">Data through ${esc(c.dataMonth)}. ${esc(model.meta.dataNote)}${model.meta.interpolated?.length ? ` Missing months filled by interpolation: ${esc(model.meta.interpolated.join(", "))}.` : ""}</div>`;
  }

  function renderDecision(model, m) {
    const d = m.decision, r0 = model.conditions.policyRate;
    const action = Math.abs(d.move) < 1e-9 ? "Hold rates steady" : `${d.move > 0 ? "Raise" : "Cut"} rates by ${Math.abs(Math.round(d.move * 100))} bp`;
    el("labDecision").innerHTML = `
      <div class="labDecisionMain">
        <div class="labDecisionK">Committee decision (simulated)</div>
        <div class="labDecisionV">${action}</div>
        <div class="muted">${pct(r0, 3)} → <strong>${pct(d.rate, 3)}</strong> · proposal ${d.passed ? "passed" : "failed — median fallback"} · ${d.dissents} of ${d.ballots.length} voters dissented</div>
      </div>
      <div class="labDisclaimer">${esc(m.disclaimer)}</div>`;
  }

  function renderOutlookSummary(model, m) {
    const prop = m.transcript.find((e) => e.step === "proposal")?.text || "";
    const reason = prop.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const ayes = m.decision.ballots.filter((b) => b.vote === "aye").length;
    const dissent = m.decision.ballots.filter((b) => b.vote === "dissent").map((b) => `${NAMES[b.id]} (preferred ${pct(b.pref, 2)})`);
    el("plReason").innerHTML = `<p>${esc(reason)}</p><p class="muted small">${ayes} of ${m.decision.ballots.length} voted yes${dissent.length ? ` · Dissent: ${esc(dissent.join(", "))}` : " · unanimous"}.</p>`;

    const k = m.decision.scenarioKey, s = model.scenarios[k], b = model.scenarios["0"], h = 11;
    const VARS = [["infl", "Inflation (core PCE)"], ["u", "Unemployment"], ["gdp", "GDP growth"], ["ffr", "Fed funds rate"]];
    const items = VARS.map(([v, label]) => {
      const lvl = `about ${s[v].mean[h].toFixed(1)}% (likely range ${s[v].p10[h].toFixed(1)}–${s[v].p90[h].toFixed(1)}%)`;
      if (k === "0") return `<li><strong>${label}:</strong> ${lvl} in 12 months.</li>`;
      const diff = s[v].mean[h] - b[v].mean[h], lo = s[v].effectLo[h], hi = s[v].effectHi[h];
      const sure = v === "ffr" || lo * hi > 0;
      return `<li><strong>${label}:</strong> ${lvl} in 12 months, vs ${b[v].mean[h].toFixed(1)}% with no change (${diff >= 0 ? "+" : ""}${diff.toFixed(2)} points).${sure ? "" : " <span class=\"muted\">The model can't reliably say whether the decision moves this up or down.</span>"}</li>`;
    }).join("");
    el("plTakeaways").innerHTML = `<p>${k === "0" ? "The committee kept rates unchanged, so the outlook below is the model's baseline." : `The committee chose to ${moveLabel(k).toLowerCase()}. Here is what the economic model estimates, 12 months from now:`}</p><ul>${items}</ul>
      <p class="muted small">These are estimates from a statistical model of the US economy fitted to 1988–2019 data, not predictions you can count on. Wide ranges mean real uncertainty. A single rate decision usually moves the economy only a little in the first year.</p>`;
  }

  function renderMembers(m) {
    const ballots = Object.fromEntries(m.decision.ballots.map((b) => [b.id, b]));
    el("labMembers").innerHTML = m.members.filter((x) => x.id !== "referee").map((mem) => {
      const i = m.initial.find((p) => p.id === mem.id), f = m.final.find((p) => p.id === mem.id), b = ballots[mem.id];
      const moved = i && f ? f.rate - i.rate : 0;
      const voteBadge = b ? (b.vote === "aye" ? `<span class="tag ok">✓ Aye</span>` : `<span class="tag warn">✗ Dissent</span>`) : "";
      const src = f?.source === "fallback" || i?.source === "fallback" ? `<span class="tag warn" title="AI call failed; rule-based position used">fallback</span>` : "";
      return `<div class="memberCard">
        <div class="memberHead"><strong>${esc(mem.name)}</strong>${voteBadge}${src}</div>
        <div class="muted memberRule">${esc(mem.rule || "Proposes the decision")}</div>
        ${i ? `<div class="memberRates"><span>${pct(i.rate, 3)}</span><span class="arrow">→</span><strong>${pct(f.rate, 3)}</strong>
          ${Math.abs(moved) >= 0.01 ? `<span class="tag">${bp(moved)} after debate</span>` : `<span class="tag muted">unchanged</span>`}</div>
          <div class="muted memberConf">Confidence ${Math.round(f.confidence * 100)}%</div>`
          : `<div class="memberRates"><strong>Proposed ${pct(m.decision.proposal, 3)}</strong></div>`}
        <div class="memberLens">${esc(mem.lens)}</div>
      </div>`;
    }).join("");
  }

  const STEP_TITLES = { conditions: "Opening", round1: "Round 1 · independent view", referee: "Referee check", round2: "Round 2 · after debate", proposal: "Chair's proposal", vote: "Vote" };
  function renderTranscript(m) {
    el("labTranscript").innerHTML = m.transcript.map((e) => {
      const who = NAMES[e.speaker] || e.speaker;
      let body = esc(e.text);
      if (e.step === "referee") {
        body += `<ul class="refList">${e.checks.map((c) => `<li><span class="verdict ${c.verdict}">${verdictLabel(c.verdict)}</span> <strong>${esc(NAMES[c.member])}:</strong> “${esc(c.text)}” <span class="muted">${esc(c.evidence)}</span></li>`).join("")}</ul>`;
      }
      const rate = e.rate != null ? `<span class="tag">${pct(e.rate, 3)}${e.from != null && Math.abs(e.rate - e.from) >= 0.01 ? ` (was ${pct(e.from, 3)})` : ""}</span>` : "";
      const err = e.error ? `<div class="muted small">AI call failed (${esc(e.error)}); used rule-based position.</div>` : "";
      return `<div class="turn turn-${e.step}"><div class="turnHead"><span class="turnStep">${STEP_TITLES[e.step] || e.step}</span><strong>${esc(who)}</strong>${rate}</div><div class="turnBody">${body}</div>${err}</div>`;
    }).join("");
  }

  function verdictLabel(v) {
    return v === "supported" ? "✓ Supported" : v === "contradicted" ? "✗ Contradicted" : "≈ Uncertain";
  }

  function renderEvidence(model, m) {
    const rows = m.checks.map((c) => `<tr><td>${esc(NAMES[c.member])}<div class="muted small">round ${c.round}</div></td><td>${esc(c.text)}</td>
      <td><span class="verdict ${c.verdict}">${verdictLabel(c.verdict)}</span><div class="muted small">${esc(c.explain)}</div></td><td class="muted small">${esc(c.evidence)}</td></tr>`).join("");
    const r = m.rules;
    const ruleRows = ["classic", "balanced", "gradualist", "momentum", "forecaster"].map((id) =>
      `<tr><td>${esc(NAMES[id])}</td><td class="mono small">${esc(r[id].formula)}</td><td>${pct(r[id].rule, 2)}</td></tr>`).join("");
    el("labEvidence").innerHTML = `
      <h4>Claims checked by the referee</h4>
      <table class="labTable"><thead><tr><th>Member</th><th>Claim</th><th>Verdict</th><th>Model evidence</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No claims were made.</td></tr>`}</tbody></table>
      <p class="muted small">“Uncertain” means the model's 80% range includes both directions — a genuine limit of the evidence, not a mistake by the agent.</p>
      <h4>Where each member's starting position comes from</h4>
      <table class="labTable"><thead><tr><th>Member</th><th>Rule</th><th>Prescribed rate</th></tr></thead><tbody>${ruleRows}</tbody></table>
      <p class="muted small">Inputs: core PCE π = ${pct(r.inputs.pi)}, unemployment u = ${pct(r.inputs.u)}, natural rate u* = ${pct(r.inputs.uStar)} (CBO), real neutral rate r* = ${r.inputs.rStar}% (assumption, from the FOMC's longer-run projection), target 2%. Members move at most 50 bp per meeting.</p>
      <h4>Voting rule</h4><p class="small">${esc(m.votingRule)}</p>
      <h4>Model assumptions</h4>
      <p class="small muted">${esc(model.meta.kind)} · ${model.meta.lags} lags · sample ${esc(model.meta.sample)} · ${esc(model.meta.identification)} · GDP bridge slope ${model.meta.gdpBridge.slope}</p>
      <ul class="small">${model.meta.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
  }

  function renderCharts(model, key) {
    const hist = model.history, fm = model.forecastMonths, labels = [...hist.months, ...fm];
    const nH = hist.months.length, pad = (arr) => [...Array(nH - 1).fill(null), ...arr];
    const base = model.scenarios["0"], scen = model.scenarios[key];
    el("labChartNote").textContent = key === "0"
      ? "Showing the baseline (no rate change). Shaded area = 80% range."
      : `Grey dashed = baseline (no change). Teal = ${key === last?.meeting?.decision?.scenarioKey ? "the committee's decision" : moveLabel(key)} (${moveLabel(key).toLowerCase()}, held ${model.meta.holdMonths} months, then set by the model). Shaded areas = 80% ranges.`;
    for (const cfg of VAR_CFG) {
      const h = cfg.key === "gdp" ? null : hist.series[cfg.key];
      const lastH = h ? h[h.length - 1] : model.conditions.gdpGrowth;
      const join = (arr) => pad([lastH, ...arr]);
      const ds = [];
      if (h) ds.push({ label: "History", data: [...h, ...Array(fm.length).fill(null)], borderColor: "#6B6B6B", borderWidth: 1.5, pointRadius: 0, tension: 0.25 });
      ds.push({ label: "Baseline P10", data: join(base[cfg.key].p10), borderColor: "transparent", pointRadius: 0, tension: 0.25 });
      ds.push({ label: "Baseline 80% range", data: join(base[cfg.key].p90), borderColor: "transparent", backgroundColor: "rgba(107,107,107,0.08)", fill: "-1", pointRadius: 0, tension: 0.25 });
      if (key !== "0") {
        ds.push({ label: "Scenario P10", data: join(scen[cfg.key].p10), borderColor: "transparent", pointRadius: 0, tension: 0.25 });
        ds.push({ label: "Scenario 80% range", data: join(scen[cfg.key].p90), borderColor: "transparent", backgroundColor: cfg.band, fill: "-1", pointRadius: 0, tension: 0.25 });
      }
      ds.push({ label: "Baseline (hold)", data: join(base[cfg.key].mean), borderColor: "#9A9A9A", borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.25 });
      if (key !== "0") ds.push({ label: `${key === last?.meeting?.decision?.scenarioKey ? "Committee decision" : moveLabel(key)}`, data: join(scen[cfg.key].mean), borderColor: cfg.color, borderWidth: 2.5, pointRadius: 0, tension: 0.25 });
      if (cfg.anchor != null) ds.push({ label: "2% target", data: labels.map(() => cfg.anchor), borderColor: "rgba(32,32,32,0.25)", borderDash: [3, 3], borderWidth: 1, pointRadius: 0 });

      labCharts[cfg.canvas]?.destroy();
      labCharts[cfg.canvas] = new Chart(el(cfg.canvas).getContext("2d"), {
        type: "line",
        data: { labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "top", labels: { color: "#6B6B6B", boxWidth: 14, font: { size: 11 }, filter: (it) => !/P10|range/.test(it.text) } },
            tooltip: {
              backgroundColor: "#FFFFFF", titleColor: "#202020", bodyColor: "#6B6B6B", borderColor: "#E8E6E3", borderWidth: 1,
              filter: (it) => !/P10|range/.test(it.dataset.label) && it.parsed.y != null,
              callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` },
            },
          },
          scales: {
            x: { ticks: { color: "#6B6B6B", maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { display: false }, border: { color: "#E8E6E3" } },
            y: { ticks: { color: "#6B6B6B", font: { size: 10 }, callback: (v) => `${v}%` }, grid: { color: "rgba(0,0,0,0.05)" }, border: { display: false } },
          },
        },
      });
    }
  }

  function renderScenarioTable(model, m) {
    const cell = (s, k, h) => `${s[k].mean[h - 1].toFixed(2)}<div class="muted small">${s[k].p10[h - 1].toFixed(1)} to ${s[k].p90[h - 1].toFixed(1)}</div>`;
    const keys = ["-50", "-25", "0", "25", "50"];
    el("labScenarioTable").innerHTML = `<table class="labTable"><thead><tr><th>Option</th><th>Inflation in 12m</th><th>Unemployment in 12m</th><th>GDP growth in 12m</th><th>Inflation in 24m</th><th>Unemployment in 24m</th></tr></thead><tbody>
      ${keys.map((k) => {
        const s = model.scenarios[k], who = [m.decision.scenarioKey, m.comparison.noDebate.scenarioKey, m.comparison.modelOnly.scenarioKey]
          .map((x, i) => (x === k ? ["Committee", "No-debate", "Model-only"][i] : null)).filter(Boolean);
        return `<tr class="${k === m.decision.scenarioKey ? "chosen" : ""}"><td><strong>${moveLabel(k)}</strong>${who.map((w) => `<div><span class="tag">${w}</span></div>`).join("")}</td>
          <td>${cell(s, "infl", 12)}</td><td>${cell(s, "u", 12)}</td><td>${cell(s, "gdp", 12)}</td><td>${cell(s, "infl", 24)}</td><td>${cell(s, "u", 24)}</td></tr>`;
      }).join("")}</tbody></table>
      <p class="muted small">Model estimates in % with 80% ranges. Overlapping ranges mean the model cannot reliably tell the options apart.</p>`;
  }

  function renderDebatePanel(m) {
    const c = m.comparison;
    const tile = (title, x, note) => `<div class="labTile"><div class="labTileK">${title}</div><div class="labTileV">${moveLabel(x.scenarioKey)}</div><div class="muted small">${pct(x.rate, 3)}${x.dissents != null ? ` · ${x.dissents} dissent${x.dissents === 1 ? "" : "s"}` : ""}</div><div class="muted small">${note}</div></div>`;
    el("labDebate").innerHTML = `
      <div class="labTiles">
        ${tile("A · No debate", c.noDebate, "Median of initial views")}
        ${tile("B · After debate", c.debate, "Committee vote")}
        ${tile("Model only", c.modelOnly, "VAR forecast targeting")}
      </div>
      <ul class="small">
        <li>Final decision ${c.sameDecision ? "is the <strong>same</strong> with or without debate" : "<strong>differs</strong> between debate and no debate"}.</li>
        <li>${c.membersChanged} of 5 members changed position by 5 bp or more (average shift ${Math.round(c.meanAbsShift * 100)} bp).</li>
        <li>Disagreement (spread of views) went from ${Math.round(c.dispersionBefore * 100)} bp to ${Math.round(c.dispersionAfter * 100)} bp${c.dispersionAfter < c.dispersionBefore ? " — debate built consensus" : ""}.</li>
        <li>${c.contradictedClaims} first-round claim(s) were contradicted by the model.</li>
      </ul>
      <p class="muted small">One meeting is an anecdote, not evidence. Accuracy can only be judged against historical decisions (historical testing is the next build stage). ${m.mode === "demo" ? "In demo mode the 'debate' is a mechanical persuasion rule, so this panel shows how the pipeline works rather than what AI debate does." : ""}</p>
      <h4>Recorded runs (this browser)</h4>
      <div id="labLog"></div>`;
    renderLog();
  }

  /* ---- Experiment log (localStorage) ---- */
  const LOG_KEY = "policyLabRuns.v1";
  function logExperiment({ model, meeting }) {
    const runs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    runs.unshift({
      at: new Date().toISOString().slice(0, 16).replace("T", " "), mode: meeting.mode, asOf: model.meta.asOf || "latest",
      r0: model.conditions.policyRate, noDebate: meeting.comparison.noDebate.rate, debate: meeting.decision.rate,
      modelOnly: meeting.comparison.modelOnly.rate, sdBefore: meeting.comparison.dispersionBefore, sdAfter: meeting.comparison.dispersionAfter,
      dissents: meeting.decision.dissents,
    });
    localStorage.setItem(LOG_KEY, JSON.stringify(runs.slice(0, 50)));
  }
  function renderLog() {
    const runs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    const box = el("labLog"); if (!box) return;
    box.innerHTML = runs.length ? `<table class="labTable small"><thead><tr><th>When</th><th>Mode</th><th>As of</th><th>Start</th><th>No debate</th><th>Debate</th><th>Model</th><th>Spread before→after</th><th>Dissents</th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td>${r.at}</td><td>${r.mode}</td><td>${r.asOf}</td><td>${pct(r.r0, 3)}</td><td>${pct(r.noDebate, 3)}</td><td>${pct(r.debate, 3)}</td><td>${pct(r.modelOnly, 3)}</td><td>${Math.round(r.sdBefore * 100)}→${Math.round(r.sdAfter * 100)} bp</td><td>${r.dissents}</td></tr>`).join("")}</tbody></table>
      <button class="btn ghost small" id="labClearLog">Clear log</button>` : `<p class="muted small">No runs yet.</p>`;
    el("labClearLog")?.addEventListener("click", () => { localStorage.removeItem(LOG_KEY); renderLog(); });
  }

  // Used by the Live Voice Debate to reveal the same meeting's results when the Chair announces them.
  window.PolicyLab = {
    show(data, { scroll = false } = {}) {
      last = data; logExperiment(data); render(data); setStep(7);
      if (scroll) setTimeout(() => el("labBody").scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    },
  };

  /* ---- Scenario selector + conditions preview ---- */
  const SCENARIO_NOTES = {
    "": "Today's economy, using the latest published data.",
    "2023-07-20": "Mid-2023: rates near their peak after the fastest hiking cycle in decades.",
    "2022-06-10": "June 2022: inflation surging well above target.",
    "2020-07-20": "July 2020: the pandemic recession, with rates already near zero.",
    "2019-07-25": "July 2019: slowing growth and trade tensions.",
    "2008-10-20": "October 2008: the global financial crisis.",
  };
  async function previewScenario() {
    const v = el("plScenario").value;
    if (v !== "custom") el("labAsOf").value = v;
    const asOf = el("labAsOf").value;
    el("plScenarioNote").textContent = v === "custom" ? `Custom date: ${asOf || "choose one in Advanced settings"}.` : SCENARIO_NOTES[v] || "";
    el("plConditions").innerHTML = `<div class="muted small">Loading economic conditions…</div>`;
    try {
      const res = await fetch(`${LAB_API}/lab/model?${new URLSearchParams({ ...(asOf ? { asOf } : {}), holdMonths: el("labHold").value })}`);
      const { model, error } = await res.json();
      if (!res.ok || error) throw new Error(error || `HTTP ${res.status}`);
      const c = model.conditions;
      const infl = c.coreInflation > 2.4 ? "above" : c.coreInflation < 1.6 ? "below" : "close to";
      const lab = c.naturalUnemployment == null ? "" : c.unemployment < c.naturalUnemployment - 0.2 ? "below its estimated natural rate (a tight job market)" : c.unemployment > c.naturalUnemployment + 0.2 ? "above its estimated natural rate (slack in the job market)" : "close to its estimated natural rate";
      const tile = (k, v) => `<div class="plStat"><div class="plStatK">${k}</div><div class="plStatV">${v}</div></div>`;
      el("plConditions").innerHTML = `<div class="plStats">${tile("Inflation (core PCE)", pct(c.coreInflation, 1))}${tile("Unemployment", pct(c.unemployment, 1))}${tile("Policy rate", pct(c.policyRate, 2))}${tile("GDP growth", pct(c.gdpGrowth, 1))}</div>
        <p class="plSummary">Inflation is ${infl} the Fed's 2% goal and unemployment is ${lab}. <span class="muted">Data through ${esc(c.dataMonth)}.</span></p>`;
    } catch (e) {
      el("plConditions").innerHTML = `<div class="muted small">Couldn't load conditions (${esc(e.message)}). You can still start a debate once the server is reachable.</div>`;
    }
  }
  el("plScenario").addEventListener("change", previewScenario);
  el("labAsOf").addEventListener("change", () => { el("plScenario").value = "custom"; previewScenario(); });

  /* ---- Wire ---- */
  el("labRunBtn").addEventListener("click", runMeeting);
  el("labCompare").addEventListener("change", (e) => last && renderCharts(last.model, e.target.value));
  el("labAsOf").max = new Date().toISOString().slice(0, 10);
  const qs = new URLSearchParams(location.search);
  if (qs.get("labAsOf")) el("labAsOf").value = qs.get("labAsOf");
  if (qs.get("labAsOf")) el("plScenario").value = "custom";
  previewScenario();
  if (qs.get("labAutoRun") === "1") runMeeting();
})();

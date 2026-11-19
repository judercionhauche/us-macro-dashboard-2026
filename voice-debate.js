/* ============================================================
   LIVE VOICE DEBATE — AI Economic Policy Lab
   The spoken debate is an audio presentation of the SAME committee process as the text
   meeting: it runs /lab/meeting first (positions, referee checks, vote, decision), then
   adds a live back-and-forth phase where each line is generated from the transcript so
   far. Speakers argue from their recorded initial to final positions, and the Chair
   announces the recorded decision. Audio: OpenAI voices via the worker (key stays
   server-side), or free browser voices. Text and audio are generated ahead of playback.
   ============================================================ */
(() => {
  // ?api= overrides; on this machine (Live Server, file://, or the dev server) use the local
  // worker on :8787, because the deployed worker may not have the Lab routes yet.
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname);
  const API = new URLSearchParams(location.search).get("api") || (IS_LOCAL ? (location.port === "8787" ? location.origin : "http://localhost:8787") : API_URL);
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pctW = (x) => `${Number(x).toFixed(2)} percent`;
  const bpW = (x) => `${Math.abs(Math.round(x * 100))} basis points`;
  const LOOKAHEAD = 2;                 // items prepared ahead of the one playing
  const JUNIOR_FIRST = ["forecaster", "momentum", "gradualist", "balanced", "classic"];
  const SILENT = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

  const S = {
    running: false, paused: false, muted: false, volume: 0.9,
    abort: null, audio: new Audio(), engine: "openai", debateId: "", cfg: null,
    items: [], played: 0, transcript: [], spendUsd: 0, meetingUsd: 0, wake: null, finishPlay: null, data: null,
    spoken: {}, members: [],
  };
  S.audio.preload = "auto";

  /* ---------------- UI helpers ---------------- */
  const NAMES = { chair: "Committee Chair", referee: "Evidence Referee", classic: "Classic Rule Analyst", balanced: "Employment-Weighted Analyst",
    gradualist: "Gradualist", momentum: "Momentum Analyst", forecaster: "Model-Based Forecaster" };
  const ROLES = { chair: "Guides the debate, proposes the decision", referee: "Checks claims against the model (non-voting)" };
  const status = (txt, kind = "") => { el("vdStatus").textContent = txt; el("vdStatus").className = `vdStatus ${kind}`; };
  const costLine = () => {
    el("vdCost").textContent = S.engine === "browser" && !S.spendUsd
      ? `Est. cost this debate: $${S.meetingUsd.toFixed(3)} (AI text only; browser voices are free)`
      : `Est. cost this debate: $${(S.spendUsd + S.meetingUsd).toFixed(3)} (limit $${(S.cfg?.debateMaxUsd ?? 0.3).toFixed(2)} for voice + turns)`;
  };

  function renderStage() {
    const ids = ["chair", ...JUNIOR_FIRST];
    el("vdStage").innerHTML = ids.map((id) => {
      const m = S.members.find((x) => x.id === id);
      return `<div class="vdAgent" id="vdA-${id}"><div class="vdAvatar">${esc(NAMES[id].split(" ").map((w) => w[0]).join("").slice(0, 2))}</div>
        <div class="vdAgentName">${esc(NAMES[id])}</div><div class="vdAgentPos small" id="vdP-${id}">${id === "chair" ? "Chair" : ""}</div></div>`;
    }).join("");
  }
  const ROLE_LINE = { classic: "Taylor (1993) rule", balanced: "Balanced-approach rule · weighs jobs more", gradualist: "Inertial rule · moves slowly",
    momentum: "First-difference rule", forecaster: "Forecast targeting with the economic model", chair: "Committee Chair", referee: "Evidence referee" };
  function setSpeaking(id) {
    document.querySelectorAll(".vdAgent").forEach((n) => n.classList.toggle("speaking", n.id === `vdA-${id}`));
    el("vdNow").classList.toggle("idle", !id);
    el("vdNowName").textContent = id ? NAMES[id] : "—";
    el("vdNowRole").textContent = id ? ROLE_LINE[id] : "";
  }
  function progress() {
    const done = S.items.slice(0, S.played).reduce((a, it) => a + (it.duration || String(it.text).split(/\s+/).length / 2.6), 0);
    const pct = Math.min(100, (done / (S.totalTarget || 120)) * 100);
    el("vdProgressFill").style.width = `${pct}%`;
    el("vdProgressText").textContent = `${Math.floor(done / 60)}:${String(Math.round(done % 60)).padStart(2, "0")} / ~${Math.round((S.totalTarget || 120) / 60)}:00`;
  }
  function addTranscript(it) {
    const box = el("vdTranscript");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const div = document.createElement("div");
    div.className = `vdLine vd-${it.speaker}`;
    div.innerHTML = `<div class="vdLineHead"><strong>${esc(NAMES[it.speaker])}</strong><span class="muted small">${esc(it.label || "")}</span></div><div>${esc(it.text)}</div>`;
    box.appendChild(div);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  /* ---------------- network ---------------- */
  // Abort on Stop OR after `ms` — a hung request must never freeze the debate.
  function timed(ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new DOMException("timeout", "TimeoutError")), ms);
    const stop = () => ac.abort(new DOMException("stopped", "AbortError"));
    S.abort.signal.addEventListener("abort", stop, { once: true });
    return { signal: ac.signal, done: () => { clearTimeout(t); S.abort.signal.removeEventListener("abort", stop); } };
  }

  async function postJSON(path, body, ms = 60000) {
    const tm = timed(ms);
    let res;
    try { res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: tm.signal }); }
    catch (e) { if (!S.running) throw new DOMException("stopped", "AbortError"); throw new Error(`${path} did not respond in time`); }
    finally { tm.done(); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return j;
  }

  async function prepareAudio(it) {
    if (S.engine !== "openai") return;
    try {
      const tm = timed(25000);
      let res;
      try {
        res = await fetch(`${API}/lab/voice/tts`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: it.text, agentId: it.speaker, debateId: S.debateId }), signal: tm.signal });
      } finally { tm.done(); }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 402 || res.status === 503) {          // budget or no key → free voices from here on
          S.engine = "browser"; el("vdEngine").value = "browser";
          status(`${j.error || "Speech unavailable"} Switched to free browser voices.`, "warn");
        }
        return;
      }
      S.spendUsd = Math.max(S.spendUsd, Number(res.headers.get("X-Lab-Spend-Debate")) || 0); costLine();
      it.audioUrl = URL.createObjectURL(await res.blob());
      await new Promise((r) => { const a = new Audio(); a.preload = "metadata"; a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) it.duration = a.duration; r(); }; a.onerror = r; a.src = it.audioUrl; setTimeout(r, 1500); });
    } catch (e) { if (S.running) console.warn("[voice] clip unavailable, using browser voice:", e.message || e.name); }
  }

  /* ---------------- queue ---------------- */
  async function enqueue(it) {
    while (S.running && S.items.length - S.played > LOOKAHEAD) await new Promise((r) => (S.wake = r));
    if (!S.running) throw new DOMException("stopped", "AbortError");
    it.ready = prepareAudio(it);
    S.items.push(it);
    S.wake?.(); // tell the player a new item exists
  }
  const say = (speaker, text, label) => enqueue({ speaker, text: String(text).replace(/\s*\[Asked for[^\]]*\]/g, "").trim(), label });

  // Resolves true when the clip ends, false if it could not play (caller falls back to the
  // browser voice). Watchdog: if playback makes no progress for 8 s while not paused, move on.
  function playAudio(url, it) {
    return new Promise((resolve) => {
      const a = S.audio;
      let done = false, lastT = -1, lastMove = Date.now();
      const finish = (v) => { if (done) return; done = true; clearInterval(iv); a.onended = a.onerror = null; resolve(v); };
      S.finishPlay = finish;
      a.src = url; a.volume = S.volume; a.muted = S.muted;
      a.onended = () => finish(true); a.onerror = () => finish(false);
      const iv = setInterval(() => {
        if (S.paused || !S.running) { lastMove = Date.now(); return; }
        if (a.currentTime !== lastT) { lastT = a.currentTime; lastMove = Date.now(); }
        if (Date.now() - lastMove > 8000) {
          console.warn(`[voice] playback stalled for ${NAMES[it.speaker]} at ${a.currentTime.toFixed(1)}s — moving on`);
          finish(a.currentTime > 0.5); // never started → speak it with the browser voice instead
        }
      }, 1000);
      a.play().catch((e) => { console.warn("[voice] play() rejected:", e.name); finish(false); });
    });
  }
  function speakBrowser(it) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return setTimeout(resolve, Math.min(9000, it.text.length * 55));
      S.finishPlay = resolve;
      const u = new SpeechSynthesisUtterance(it.text);
      const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
      const order = ["chair", "classic", "balanced", "gradualist", "momentum", "forecaster", "referee"];
      if (voices.length) u.voice = voices[order.indexOf(it.speaker) % voices.length];
      const b = S.cfg?.voices?.[it.speaker]?.browser || {};
      u.pitch = b.pitch ?? 1; u.rate = b.rate ?? 1; u.volume = S.muted ? 0 : S.volume;
      u.onend = () => resolve(); u.onerror = () => resolve();
      setTimeout(resolve, it.text.length * 120 + 3000); // guard: some browsers never fire onend
      speechSynthesis.speak(u);
    });
  }

  async function player() {
    while (S.running) {
      if (S.played >= S.items.length) {
        if (S.producerDone) break;
        setSpeaking(null);
        el("vdNowName").textContent = "The committee is preparing the next speaker…";
        await new Promise((r) => (S.wake = r));
        continue;
      }
      const it = S.items[S.played];
      await it.ready;
      while (S.paused && S.running) await new Promise((r) => setTimeout(r, 200));
      if (!S.running) break;
      setSpeaking(it.speaker);
      addTranscript(it);
      S.transcriptShown = (S.transcriptShown || 0) + 1;
      if (it.onPlay) it.onPlay();
      const ok = it.audioUrl ? await playAudio(it.audioUrl, it) : false;
      if (ok === false && S.running) await speakBrowser(it);
      if (it.audioUrl) URL.revokeObjectURL(it.audioUrl);
      S.played++;
      progress();
      S.wake?.(); // let the producer prepare the next item
      await new Promise((r) => setTimeout(r, 250)); // short natural gap between speakers
    }
    setSpeaking(null);
  }

  /* ---------------- debate script (producer) ---------------- */
  // Speaking-time plan for the 2-minute format (seconds); scaled by the duration setting.
  const PLAN = { opening: 20, debate: 60, finals: 25, conclusion: 15 };
  const WPS = 2.4; // spoken words per second (measured on gpt-4o-mini-tts), used until real audio durations are known
  const words = (t) => String(t).trim().split(/\s+/).length;
  const secs = (it) => it.duration || words(it.text) / WPS;
  const spentIn = (phase) => S.items.filter((it) => it.phase === phase).reduce((a, it) => a + secs(it), 0);
  const plannedTotal = () => S.items.reduce((a, it) => a + secs(it), 0);

  function buildContext(model, m) {
    const s25 = model.scenarios["25"];
    const eff = (k, label) => `${label} ${s25[k].effect[11] >= 0 ? "+" : ""}${s25[k].effect[11].toFixed(2)} points (80% range ${s25[k].effectLo[11].toFixed(2)} to ${s25[k].effectHi[11].toFixed(2)})`;
    const counts = m.checks.reduce((a, c) => ((a[c.verdict] = (a[c.verdict] || 0) + 1), a), {});
    return {
      conditions: model.conditions,
      members: m.initial.map((p) => ({ id: p.id, rule: m.members.find((x) => x.id === p.id)?.rule, initial: p.rate,
        final: m.final.find((q) => q.id === p.id).rate, capped: /capped|Limiting moves/i.test(p.summary) })),
      effects: [eff("infl", "core inflation"), eff("u", "unemployment"), eff("gdp", "GDP growth")].join("; "),
      baseline: ["infl", "u", "gdp"].map((k) => { const b = model.scenarios["0"][k]; return `${{ infl: "core inflation", u: "unemployment", gdp: "GDP growth" }[k]} ${b.mean[11].toFixed(2)} percent (80% range ${b.p10[11].toFixed(1)} to ${b.p90[11].toFixed(1)})`; }).join("; "),
      refereeSummary: `${m.checks.length} claims checked: ${counts.supported || 0} supported, ${counts.contradicted || 0} contradicted, ${counts.uncertain || 0} uncertain`,
    };
  }

  function nextPair(t, prev, ctx) {
    const mem = ctx.members;
    const least = (ex) => mem.filter((m) => !ex.includes(m.id)).sort((a, b) => (S.spoken[a.id] || 0) - (S.spoken[b.id] || 0))[0];
    if (t === 0) {
      const sorted = [...mem].sort((a, b) => a.initial - b.initial);
      const med = sorted[2];
      const target = [...mem].sort((a, b) => Math.abs(b.initial - med.initial) - Math.abs(a.initial - med.initial))[0];
      return { speakerId: "chair", addresseeId: target.id, purpose: "moderate" };
    }
    if (t % 5 === 0) return { speakerId: "chair", addresseeId: least([prev?.speaker]).id, purpose: "moderate" };
    const speaker = prev && prev.addressee !== "chair" ? mem.find((m) => m.id === prev.addressee) || least([prev?.speaker]) : least([prev?.speaker]);
    const others = mem.filter((m) => m.id !== speaker.id);
    let addressee = prev && prev.speaker !== "chair" && prev.addressee === speaker.id ? others.find((m) => m.id === prev.speaker) : null;
    if (!addressee || (S.pairCount[`${speaker.id}|${addressee.id}`] || 0) >= 1) {
      addressee = others.sort((a, b) => Math.abs(b.final - speaker.final) - Math.abs(a.final - speaker.final) || (S.spoken[a.id] || 0) - (S.spoken[b.id] || 0))[0];
    }
    return { speakerId: speaker.id, addresseeId: addressee.id, purpose: "respond" };
  }

  function openingLine(id, rules, r0) {
    const rate = rules[id].rule, d = rate - r0;
    const lean = d > 0.12 ? "I lean toward raising rates" : d < -0.12 ? "I lean toward a cut" : "I lean toward holding";
    const n = `${Number(rate).toFixed(1)} percent`;
    return {
      forecaster: `The model's projections favor ${d > 0.12 ? "a hike" : d < -0.12 ? "a cut" : "holding steady"}.`,
      momentum: `Inflation's above target; my rule says about ${n}. ${lean}.`,
      gradualist: `I'd move carefully. Smoothing gets me to ${n}.`,
      balanced: `Even weighting jobs heavily, I get ${n}. ${lean}.`,
      classic: `The classic Taylor rule says ${n}. ${lean}.`,
    }[id];
  }

  async function producer(params) {
    const scale = Number(el("vdLength").value) / 2;            // 2, 4 or 6 minutes
    const P = Object.fromEntries(Object.entries(PLAN).map(([k, v]) => [k, v * scale]));
    S.totalTarget = Object.values(P).reduce((a, b) => a + b, 0);
    const engine = params.mode === "demo" ? "demo" : "auto";

    // 1) model + rules first (fast, cached) so the opening plays while the committee meets
    status("Preparing the meeting…");
    const meetingP = postJSON("/lab/meeting", params, 150000);
    meetingP.catch(() => {});
    let model, rules, lastErr;
    for (let attempt = 0; attempt < 2 && !model; attempt++) {   // one retry: FRED occasionally hiccups
      try {
        const mres = await fetch(`${API}/lab/model?${new URLSearchParams({ ...(params.asOf ? { asOf: params.asOf } : {}), holdMonths: params.holdMonths })}`, { signal: S.abort.signal });
        const j = await mres.json().catch(() => ({}));
        if (!mres.ok || !j.model) throw new Error(j.error || `server returned ${mres.status}`);
        ({ model, rules } = j);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
        if (attempt === 0) { status("Data source was slow — retrying…", "warn"); await new Promise((r) => setTimeout(r, 1500)); }
      }
    }
    if (!model) throw new Error(`couldn't load the economic data (${lastErr?.message || "unknown error"}). Please try again in a moment.`);
    const c = model.conditions, r0 = c.policyRate;
    status("Opening assessments");
    await enqueue({ phase: "opening", speaker: "chair", label: "Opening",
      text: `Welcome. Inflation is ${c.coreInflation.toFixed(1)} percent, unemployment ${c.unemployment.toFixed(1)}. Do we move rates? Quick views.` });
    for (const id of JUNIOR_FIRST) await enqueue({ phase: "opening", speaker: id, label: "Opening view", text: openingLine(id, rules, r0) });

    const data = await meetingP;
    S.data = data;
    const m = data.meeting;
    S.meetingUsd = m.usage ? (m.usage.input * S.cfg.llmUsdPer1mIn + m.usage.output * S.cfg.llmUsdPer1mOut) / 1e6 : 0;
    costLine();
    const ctx = buildContext(model, m);
    m.initial.forEach((p) => { const n = el(`vdP-${p.id}`); if (n) n.textContent = `${p.rate.toFixed(2)}%`; });

    // 2) debate: continue while the spoken-time budget allows (real audio durations when known)
    S.pairCount = {}; let prev = null;
    const debateBudget = () => S.totalTarget - spentIn("opening") - P.finals - P.conclusion;
    for (let t = 0; S.running && t < S.cfg.maxTurns; t++) {
      const left = debateBudget() - spentIn("debate");
      if (left < 7) break;
      const maxWords = Math.round(Math.max(18, Math.min(t === 0 ? 30 : 42 * Math.min(scale, 2), left * WPS)));
      status("Debate");
      const pair = nextPair(t, prev, ctx);
      let text;
      try {
        const r = await postJSON("/lab/voice/turn", { ctx, transcript: S.transcript, ...pair, maxWords, turn: t, totalTurns: Math.round(P.debate / 13), debateId: S.debateId, engine });
        text = r.text;
        if (r.spend) { S.spendUsd = Math.max(S.spendUsd, r.spend.debateUsd); costLine(); }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (e.status === 402) { status(e.message, "warn"); break; }
        continue;
      }
      S.transcript.push({ speaker: pair.speakerId, text });
      S.spoken[pair.speakerId] = (S.spoken[pair.speakerId] || 0) + 1;
      S.pairCount[`${pair.speakerId}|${pair.addresseeId}`] = (S.pairCount[`${pair.speakerId}|${pair.addresseeId}`] || 0) + 1;
      prev = { speaker: pair.speakerId, addressee: pair.addresseeId };
      await enqueue({ phase: "debate", speaker: pair.speakerId, text, label: pair.speakerId === "chair" ? `to ${NAMES[pair.addresseeId]}` : `responding to ${NAMES[pair.addresseeId]}` });
    }

    // 3) final recommendations + votes (recorded votes; short generated reasons)
    const d = m.decision;
    const votes = Object.fromEntries(d.ballots.map((b) => [b.id, b.vote]));
    const action = Math.abs(d.move) < 1e-9 ? `hold the rate at ${pctW(d.rate)}` : `${d.move > 0 ? "raise" : "cut"} rates by ${bpW(d.move)}, to ${pctW(d.rate)}`;
    let lines = {};
    try {
      lines = (await postJSON("/lab/voice/finals", { ctx, transcript: S.transcript, decision: { votes, text: action }, debateId: S.debateId, engine })).lines || {};
    } catch (e) { if (e.name === "AbortError") throw e; }
    status("Final recommendations and vote");
    await enqueue({ phase: "finals", speaker: "chair", label: "Vote", text: `The proposal: ${action}. Your votes?` });
    for (const id of JUNIOR_FIRST) {
      const b = d.ballots.find((x) => x.id === id);
      const reason = lines[id] ? `${lines[id].replace(/[.!]$/, "")}. ` : "";
      await enqueue({ phase: "finals", speaker: id, label: b.vote === "aye" ? "Votes yes" : "Dissents",
        text: reason + (b.vote === "aye" ? "I vote yes." : `I dissent; I'd prefer ${Number(b.pref).toFixed(2)} percent.`),
        onPlay: () => { const n = el(`vdP-${id}`); if (n) n.textContent = b.vote === "aye" ? "✓ Yes" : "✗ Dissent"; } });
    }

    // 4) Chair's conclusion — exactly the recorded decision
    status("Chair's conclusion");
    const tally = d.dissents ? `with ${d.dissents} dissent${d.dissents === 1 ? "" : "s"}` : "unanimously";
    await enqueue({ phase: "conclusion", speaker: "chair", label: "Decision",
      text: `${d.passed ? "" : "The proposal lacked a majority, so by our rule we take the median view. "}The committee will ${action}, ${tally}. ${lines.chair_reason ? lines.chair_reason.replace(/[.!]?$/, ".") : ""} This is a simulation. The projected economic effects follow below.` });
  }

  /* ---------------- controls ---------------- */
  async function start() {
    if (S.running) return;
    // unlock audio playback inside the click gesture (autoplay policies)
    S.audio.src = SILENT; S.audio.play().catch(() => {});
    if ("speechSynthesis" in window) speechSynthesis.getVoices();
    Object.assign(S, { running: true, paused: false, abort: new AbortController(), items: [], played: 0, transcript: [], spendUsd: 0, meetingUsd: 0,
      producerDone: false, debateId: `vd-${Date.now().toString(36)}`, spoken: {}, data: null, engine: el("vdEngine").value });
    el("vdTranscript").innerHTML = ""; el("vdPanelBody").hidden = false; el("labBody").hidden = true;
    document.getElementById("policyLab").classList.add("isLive");
    el("vdProgressFill").style.width = "0%";
    setButtons();
    try {
      S.cfg = S.cfg || await (await fetch(`${API}/lab/voice/config`)).json();
      if (S.engine === "openai" && !S.cfg.ttsAvailable) { S.engine = "browser"; el("vdEngine").value = "browser"; }
      S.members = [{ id: "classic", rule: "Taylor (1993) rule" }, { id: "balanced", rule: "Balanced-approach rule" }, { id: "gradualist", rule: "Inertial rule (smoothing 0.85)" },
        { id: "momentum", rule: "First-difference rule" }, { id: "forecaster", rule: "Forecast targeting with the VAR" }];
      renderStage(); costLine();
      const params = { asOf: el("labAsOf").value || null, holdMonths: Number(el("labHold").value), mode: el("labMode").value };
      const playing = player();
      try { await producer(params); }
      finally { S.producerDone = true; S.wake?.(); }
      await playing;
      if (S.running) {
        status("Finished — see the decision and economic outlook below.", "ok");
        el("vdProgressFill").style.width = "100%";
        window.PolicyLab?.show(S.data, { scroll: true });
      }
    } catch (e) {
      if (e.name !== "AbortError") status(`Debate stopped: ${e.message}`, "error");
    } finally {
      S.running = false; setSpeaking(null); setButtons();
      document.getElementById("policyLab").classList.remove("isLive");
    }
  }

  function stop() {
    if (!S.running) return;
    S.running = false;
    S.abort?.abort();                               // cancels pending text + audio requests
    S.audio.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    S.finishPlay?.(); S.wake?.();
    S.items.slice(S.played).forEach((it) => it.audioUrl && URL.revokeObjectURL(it.audioUrl));
    status("Stopped by user.", "warn");
  }

  function togglePause() {
    if (!S.running) return;
    S.paused = !S.paused;
    if (S.paused) { S.audio.pause(); if ("speechSynthesis" in window) speechSynthesis.pause(); }
    else { if (S.audio.src && !S.audio.ended && S.audio.currentTime > 0) S.audio.play().catch(() => {}); if ("speechSynthesis" in window) speechSynthesis.resume(); }
    el("vdPause").textContent = S.paused ? "Resume" : "Pause";
    el("vdNow").classList.toggle("paused", S.paused);
  }

  function setButtons() {
    el("vdStart").disabled = S.running;
    el("vdStart").textContent = S.data && !S.running ? "Start a new debate" : "Start Live Debate";
    el("vdPause").disabled = el("vdStop").disabled = !S.running;
    el("vdPause").textContent = "Pause";
    el("labRunBtn").disabled = S.running;
  }

  el("vdStart").addEventListener("click", start);
  el("vdStop").addEventListener("click", stop);
  el("vdPause").addEventListener("click", togglePause);
  el("vdMute").addEventListener("click", () => {
    S.muted = !S.muted; S.audio.muted = S.muted;
    el("vdMute").textContent = S.muted ? "Unmute" : "Mute";
  });
  el("vdVolume").addEventListener("input", (e) => { S.volume = Number(e.target.value); S.audio.volume = S.volume; });
  window.addEventListener("beforeunload", stop);
  // Testing/demo hook: ?vdAutoStart=1&vdEngine=browser&vdLength=6&labMode=demo
  const qs = new URLSearchParams(location.search);
  if (qs.get("labMode")) el("labMode").value = qs.get("labMode");
  if (qs.get("vdEngine")) el("vdEngine").value = qs.get("vdEngine");
  if (qs.get("vdLength")) el("vdLength").value = qs.get("vdLength");
  if (qs.get("vdAutoStart") === "1") start();
})();

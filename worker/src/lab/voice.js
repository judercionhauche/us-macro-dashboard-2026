// lab/voice.js — Live Voice Debate support for the AI Economic Policy Lab.
//
//  * /lab/voice/turn  — generates ONE conversational turn. The browser sends the meeting
//    context (positions, referee checks from /lab/meeting) and the transcript so far; the
//    speaker responds to what was actually said. Speakers argue from their recorded initial
//    position toward their recorded final position, so the spoken debate stays consistent
//    with the committee's text record and vote (the decision itself is never generated here).
//  * /lab/voice/tts   — text-to-speech proxy (OpenAI). Voices are assigned server-side so
//    every agent keeps one voice; the API key never reaches the browser.
//  * Spend tracker    — estimated per-debate and per-process caps. These are ESTIMATES from
//    token/character counts; the only hard guarantee is a spending limit set in the OpenAI
//    dashboard.

import { MEMBERS, CHAIR, REFEREE, llmProvider, callLLM } from "./committee.js";
import { reserve, record } from "./budget.js";

export const VOICES = {
  chair:      { voice: "onyx",  browser: { pitch: 0.85, rate: 0.98 }, style: "Authoritative, balanced and professional, like a central bank chair running a meeting. Steady pace." },
  classic:    { voice: "ash",   browser: { pitch: 1.0,  rate: 1.0 },  style: "Firm, confident and analytical. Clear and direct." },
  balanced:   { voice: "coral", browser: { pitch: 1.15, rate: 0.96 }, style: "Calm, concerned and thoughtful; warm, focused on people's jobs." },
  gradualist: { voice: "sage",  browser: { pitch: 0.95, rate: 0.92 }, style: "Measured and cautious; unhurried, careful wording." },
  momentum:   { voice: "verse", browser: { pitch: 1.1,  rate: 1.08 }, style: "Energetic and evidence-focused; brisk, engaged." },
  forecaster: { voice: "nova",  browser: { pitch: 1.25, rate: 1.02 }, style: "Precise and data-driven; crisp, neutral delivery." },
  referee:    { voice: "fable", browser: { pitch: 0.9,  rate: 1.0 },  style: "Neutral fact-checker; even, matter-of-fact tone." },
};
const TTS1_FALLBACK = { verse: "echo", sage: "shimmer", coral: "alloy", ballad: "fable" }; // tts-1 has fewer voices

/* ============================ COST TRACKING ============================ */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
export function voiceConfig(env = {}) {
  const prov = llmProvider(env);
  return {
    ttsAvailable: !!env.OPENAI_API_KEY,
    ttsModel: env.LAB_TTS_MODEL || "gpt-4o-mini-tts",
    llm: prov ? `${prov.name} ${prov.model}` : null,
    // Approximate list prices in USD (override via env if they change):
    ttsUsdPer1kChars: num(env.LAB_TTS_USD_PER_1K_CHARS, 0.015),   // ≈ $0.015/min of speech
    llmUsdPer1mIn: num(env.LAB_LLM_USD_PER_1M_IN, 0.15),          // gpt-4o-mini input
    llmUsdPer1mOut: num(env.LAB_LLM_USD_PER_1M_OUT, 0.60),        // gpt-4o-mini output
    debateMaxUsd: num(env.LAB_VOICE_DEBATE_MAX_USD, 0.45),
    processMaxUsd: num(env.LAB_VOICE_TOTAL_MAX_USD, 3.00),
    maxTurns: num(env.LAB_VOICE_MAX_TURNS, 20),
    maxCharsPerLine: 900,
  };
}

const spend = { total: 0, debates: new Map() };
function debateSpend(id) { return spend.debates.get(id) || 0; }
function addSpend(id, usd) {
  spend.total += usd;
  spend.debates.set(id, debateSpend(id) + usd);
  if (spend.debates.size > 200) spend.debates.delete(spend.debates.keys().next().value);
}
function budgetError(cfg, id, nextUsd) {
  if (debateSpend(id) + nextUsd > cfg.debateMaxUsd) return `Per-debate cost limit reached (≈$${debateSpend(id).toFixed(3)} of $${cfg.debateMaxUsd.toFixed(2)}).`;
  if (spend.total + nextUsd > cfg.processMaxUsd) return `Server cost limit reached (≈$${spend.total.toFixed(3)} of $${cfg.processMaxUsd.toFixed(2)} since restart).`;
  return null;
}
export function spendSnapshot(id) {
  return { debateUsd: Math.round(debateSpend(id) * 10000) / 10000, totalUsd: Math.round(spend.total * 10000) / 10000 };
}

/* ============================ TURN GENERATION ============================ */

const lineTool = (maxWords) => ({
  name: "say",
  description: "Say your next line in the live debate.",
  input_schema: {
    type: "object",
    properties: { line: { type: "string", description: `What you say aloud: at most ${maxWords} words, natural spoken English, no lists or markdown.` } },
    required: ["line"],
  },
});

const nameOf = (id) => [...MEMBERS, CHAIR, REFEREE].find(m => m.id === id)?.name || id;
const pctW = (x) => `${Number(x).toFixed(2)} percent`;

function contextText(ctx) {
  const c = ctx.conditions || {};
  const lines = [
    `Economic conditions (data through ${c.dataMonth}): policy rate ${pctW(c.policyRate)}, core inflation ${pctW(c.coreInflation)} (target 2), unemployment ${pctW(c.unemployment)} (estimated natural rate ${pctW(c.naturalUnemployment)}), GDP growth ${pctW(c.gdpGrowth)}.`,
    `The policy rate is now ${pctW(c.policyRate)}: any position above it means a rate hike, below it a cut, equal to it a hold.`,
    `Committee positions (start → where each member ends up after the debate):`,
    ...(ctx.members || []).map(m => `- ${nameOf(m.id)} (${m.rule}): starts at ${pctW(m.initial)}, ends at ${pctW(m.final)}.${m.capped ? " Their rule wanted an even bigger move but moves are capped at 50 basis points per meeting." : ""}`),
    `Statistical model (VAR) baseline with no rate change, 12 months ahead: ${ctx.baseline || "not provided"}.`,
    `Statistical model (VAR) effect of a 25 basis point hike after 12 months: ${ctx.effects || "uncertain"}.`,
    `How to read the labor data: unemployment BELOW its natural rate means the labor market is TIGHT (adds inflation pressure); ABOVE it means slack.`,
    `Referee findings: ${ctx.refereeSummary || "none"}.`,
  ];
  return lines.join("\n");
}

function demoLine(ctx, speakerId, addresseeId, purpose) {
  const m = (ctx.members || []).find(x => x.id === speakerId), a = (ctx.members || []).find(x => x.id === addresseeId);
  if (speakerId === "chair") {
    return purpose === "wrap"
      ? "Thank you all. I think we've heard the main arguments. Let's each state where we land, and then we'll vote."
      : `${nameOf(addresseeId)}, you're at ${a ? pctW(a.initial) : "a different place"}. Can you respond to the arguments we've heard so far?`;
  }
  return `${a ? nameOf(addresseeId) + ", " : ""}I hear your point, but my ${m?.rule || "framework"} still points to about ${m ? pctW(m.final) : "my current view"}. ` +
    `Core inflation is ${pctW(ctx.conditions?.coreInflation)}, and the model says the effect of a quarter-point move on jobs is uncertain, so I weigh the inflation risk accordingly.`;
}

export async function voiceTurn(env, body) {
  const cfg = voiceConfig(env);
  const { ctx = {}, transcript = [], speakerId, addresseeId, purpose = "respond", turn = 0, totalTurns = 12, debateId = "anon" } = body || {};
  const maxWords = Math.max(15, Math.min(130, Math.round(Number(body?.maxWords) || 60)));
  if (![...MEMBERS, CHAIR].some(m => m.id === speakerId)) throw new Error("Unknown speaker");
  const prov = llmProvider(env);
  if (!prov || body.engine === "demo") {
    const t = demoLine(ctx, speakerId, addresseeId, purpose).split(/\s+/);
    return { text: t.slice(0, maxWords).join(" ") + (t.length > maxWords ? "." : ""), source: "template", spend: spendSnapshot(debateId) };
  }

  const est = (6000 * cfg.llmUsdPer1mIn + 250 * cfg.llmUsdPer1mOut) / 1e6;
  const blocked = budgetError(cfg, debateId, est);
  if (blocked) { const e = new Error(blocked); e.status = 402; throw e; }

  const recent = transcript.slice(-14).map(t => `${nameOf(t.speaker)}: ${String(t.text).slice(0, 700)}`).join("\n");
  const me = (ctx.members || []).find(m => m.id === speakerId);
  const isChair = speakerId === "chair";
  const task = isChair
    ? (purpose === "wrap"
        ? "Close the open discussion: briefly summarize the main disagreement and the strongest arguments on each side, and say the committee will now state final positions and vote. Do NOT announce a decision."
        : `Guide the discussion: pick up an unresolved disagreement from what was just said and put a pointed question to ${nameOf(addresseeId)}. Invite the opposing view. Do NOT reveal or announce a decision.`)
    : `Respond directly to ${nameOf(addresseeId)}'s most recent point (quote or paraphrase it), then make your own argument. ` +
      `You may disagree, ask them a pointed question, concede something, or cite the model and data. ` +
      `Your view: you started at ${pctW(me?.initial)} and, by the end of the debate, you will settle at ${pctW(me?.final)}` +
      (Math.abs((me?.final ?? 0) - (me?.initial ?? 0)) >= 0.05 ? ", so show yourself being partly persuaded where it is honest." : ", so hold your ground unless a fair point deserves a concession.") +
      " When you mention your own recommendation, use only your own number above, never the current rate or someone else's. Do not announce votes.";

  const system = `You are the "${nameOf(speakerId)}" in a LIVE, spoken, simulated monetary policy committee debate in a university research tool. You are an analytical perspective, not a real Federal Reserve official.
${isChair ? CHAIR.lens : (MEMBERS.find(m => m.id === speakerId)?.lens || "")}
Speak naturally, as in a short live panel debate: address colleagues by role name, react to the substance of what they just said, never repeat a point already made, bring one specific piece of evidence when you can, and keep it understandable for a student. Hard limit: ${maxWords} words — be concise and pointed. Use only the numbers in the context; say "percent" and "basis points" in words. No lists, no markdown, no stage directions.`;
  const user = `${contextText(ctx)}\n\nConversation so far (most recent last):\n${recent || "(the meeting has just opened)"}\n\nThis is turn ${turn + 1} of about ${totalTurns} in the open discussion.\nYour task: ${task}`;

  const usage = { calls: 0, input: 0, output: 0 };
  let out;
  try { out = await callLLM(env, usage, system, user, lineTool(maxWords)); }
  catch (e) { if (e.status === 402) { const err = new Error(e.message); err.status = 402; throw err; } throw e; }
  addSpend(debateId, (usage.input * cfg.llmUsdPer1mIn + usage.output * cfg.llmUsdPer1mOut) / 1e6);
  const text = String(out.line || "").replace(/[*_#`]/g, "").trim().split(/\s+/).slice(0, maxWords + 10).join(" ").slice(0, cfg.maxCharsPerLine);
  if (!text) throw new Error("Empty line from model");
  return { text, source: prov.name, usage, spend: spendSnapshot(debateId) };
}

/* ============================ FINAL ROUND ============================ */
// One call writes every member's short closing reason plus the Chair's one-sentence
// rationale. Votes and rates are NOT generated: the browser attaches the recorded vote.
const FINALS_TOOL = {
  name: "final_round",
  description: "Short closing reasons for each member and the Chair.",
  input_schema: {
    type: "object",
    properties: {
      ...Object.fromEntries(MEMBERS.map(m => [m.id, { type: "string", description: `${m.name}: closing reason, at most 8 words, referring to the debate` }])),
      chair_reason: { type: "string", description: "Chair: why the committee reached its decision, at most 22 words" },
    },
    required: [...MEMBERS.map(m => m.id), "chair_reason"],
  },
};

const finalsTemplate = (ctx) => ({
  ...Object.fromEntries((ctx.members || []).map(m => [m.id, m.final > (ctx.conditions?.policyRate ?? 0) + 0.12
    ? "Inflation is still above target, so I want tighter policy"
    : m.final < (ctx.conditions?.policyRate ?? 0) - 0.12 ? "The labor market needs support" : "The evidence doesn't justify a move yet"])),
  chair_reason: "Inflation remains above target while the labor market is still solid.",
});

export async function voiceFinals(env, body) {
  const cfg = voiceConfig(env);
  const { ctx = {}, transcript = [], decision = {}, debateId = "anon" } = body || {};
  const prov = llmProvider(env);
  if (!prov || body.engine === "demo") return { lines: finalsTemplate(ctx), source: "template", spend: spendSnapshot(debateId) };
  const blocked = budgetError(cfg, debateId, (6000 * cfg.llmUsdPer1mIn + 300 * cfg.llmUsdPer1mOut) / 1e6);
  if (blocked) return { lines: finalsTemplate(ctx), source: "template", note: blocked, spend: spendSnapshot(debateId) };
  const recent = transcript.slice(-12).map(t => `${nameOf(t.speaker)}: ${String(t.text).slice(0, 600)}`).join("\n");
  const votes = (ctx.members || []).map(m => `- ${nameOf(m.id)}: final position ${pctW(m.final)}, votes ${decision.votes?.[m.id] || "aye"}`).join("\n");
  const usage = { calls: 0, input: 0, output: 0 };
  try {
    const out = await callLLM(env, usage,
      "You write the closing round of a short, spoken, simulated monetary policy debate in a university tool (not the real Fed). Each line is a brief spoken reason consistent with that member's final position and vote and with what they argued. No numbers unless essential, no markdown.",
      `${contextText(ctx)}\n\nDebate transcript:\n${recent}\n\nFinal positions and votes (already decided):\n${votes}\nCommittee decision: ${decision.text || ""}\n\nWrite the closing reasons.`,
      FINALS_TOOL);
    addSpend(debateId, (usage.input * cfg.llmUsdPer1mIn + usage.output * cfg.llmUsdPer1mOut) / 1e6);
    const clean = (x, n) => String(x || "").replace(/[*_#`]/g, "").trim().split(/\s+/).slice(0, n).join(" ").replace(/[.,;:]$/, "");
    const tpl = finalsTemplate(ctx);
    const lines = Object.fromEntries([...MEMBERS.map(m => [m.id, clean(out[m.id], 11) || tpl[m.id]]), ["chair_reason", clean(out.chair_reason, 28) || tpl.chair_reason]]);
    return { lines, source: prov.name, spend: spendSnapshot(debateId) };
  } catch (e) {
    return { lines: finalsTemplate(ctx), source: "template", note: String(e.message || e).slice(0, 120), spend: spendSnapshot(debateId) };
  }
}

/* ============================ TEXT TO SPEECH ============================ */

const ttsCache = new Map(); // key → ArrayBuffer (reuse identical audio)
async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function voiceTTS(env, body) {
  const cfg = voiceConfig(env);
  const { text = "", agentId = "chair", debateId = "anon" } = body || {};
  if (!cfg.ttsAvailable) { const e = new Error("No OPENAI_API_KEY configured for speech"); e.status = 503; throw e; }
  const input = String(text).slice(0, cfg.maxCharsPerLine).trim();
  if (!input) { const e = new Error("Empty text"); e.status = 400; throw e; }
  const v = VOICES[agentId] || VOICES.chair;
  const isTts1 = cfg.ttsModel.startsWith("tts-1");
  const voice = isTts1 ? (TTS1_FALLBACK[v.voice] || v.voice) : v.voice;

  const key = await sha(`${cfg.ttsModel}|${voice}|${v.style}|${input}`);
  if (ttsCache.has(key)) return { audio: ttsCache.get(key), cached: true, spend: spendSnapshot(debateId) };

  const est = (input.length / 1000) * cfg.ttsUsdPer1kChars;
  const blocked = budgetError(cfg, debateId, est);
  if (blocked) { const e = new Error(blocked); e.status = 402; throw e; }

  await reserve(env, est, "speech generation");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.ttsModel, voice, input, response_format: "mp3", ...(isTts1 ? {} : { instructions: v.style }) }),
    signal: AbortSignal.timeout(Number(env.LAB_TTS_TIMEOUT_MS || 25000)),
  }).catch((e) => { const err = new Error(`Speech API did not respond (${e.name})`); err.status = 504; throw err; });
  if (!res.ok) { const e = new Error(`Speech API ${res.status}: ${(await res.text()).slice(0, 160)}`); e.status = 502; throw e; }
  const audio = await res.arrayBuffer();
  addSpend(debateId, est);
  await record(env, est);
  ttsCache.set(key, audio);
  if (ttsCache.size > 150) ttsCache.delete(ttsCache.keys().next().value);
  return { audio, cached: false, spend: spendSnapshot(debateId) };
}

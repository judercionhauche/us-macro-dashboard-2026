// lab/committee.js — Policy Rule Committee for the AI Economic Policy Lab.
//
// Design (adapted from FOMC In Silico, Kazinnik & Sinclair 2026):
//  * Five voting members, each anchored to a published monetary-policy rule (the rules the
//    Fed reports in its Monetary Policy Report) or to the estimated VAR. Their starting
//    positions are therefore computable and defensible, not invented personas.
//  * A Chair who proposes the decision (votes aye), and a non-voting Referee that checks
//    every claim against the estimated model.
//  * Two tracks from the SAME initial positions:
//      A) No debate: fixed aggregation (median of initial recommendations).
//      B) Debate: members see each other's arguments and the referee's checks, revise,
//         then vote on the Chair's proposal.
//  * Live mode uses Claude for members and Chair. Demo mode (no API key) uses a documented
//    Bayesian persuasion rule instead of LLM debate — it is a mechanical stand-in.
//  * Numerical economic outcomes always come from the model, never from the agents.

import { CANDIDATE_MOVES, policyEffectAt, baselineChangeAt } from "./model.js";
import { snapshotBriefing } from "./snapshot.js";
import { reserve, record, prices } from "./budget.js";

export const R_STAR = 1.0;       // real neutral rate (FOMC SEP longer-run 3.0% nominal − 2% target)
export const PI_STAR = 2.0;      // inflation target (PCE)
export const MAX_STEP = 0.5;     // gradualism: a member recommends at most ±50 bp per meeting
export const DISSENT_GAP = 0.25; // a voter dissents if its final preference is ≥25 bp from the proposal
const KAPPA = 0.25;              // belief sd = KAPPA·(1−c)/c, as in the paper
const PERSUASION = 0.3;
const MIN_MODEL_GAIN = 0.01;     // forecaster: required relative loss improvement over holding          // demo mode: weight on another member's view relative to one's own

export const VOTING_RULE = "Six voters (five members + Chair). A voter dissents if its final preferred rate is at least 25 bp away from the Chair's proposal. The proposal passes unless a majority (4 or more) dissents; if it fails, the decision is the median of members' final preferences, rounded to 25 bp. The Chair votes for its own proposal.";

const LABELS = { infl: "core inflation", u: "unemployment", ip: "industrial production growth", gdp: "GDP growth", ffr: "the fed funds rate" };

export const MEMBERS = [
  { id: "classic", name: "Classic Rule Analyst", rule: "Taylor (1993) rule",
    lens: "Follows the original Taylor rule: equal concern for inflation and economic slack, with a modest weight on the labor market." },
  { id: "balanced", name: "Employment-Weighted Analyst", rule: "Balanced-approach rule",
    lens: "Uses the balanced-approach rule, which puts twice the weight on labor-market slack. Most concerned about unnecessary job losses." },
  { id: "gradualist", name: "Gradualist", rule: "Inertial rule (smoothing 0.85)",
    lens: "Believes policy should move slowly and predictably: only 15% of the rule-implied gap is closed each meeting." },
  { id: "momentum", name: "Momentum Analyst", rule: "First-difference rule",
    lens: "Ignores the uncertain neutral rate; reacts to inflation above target and to how fast labor-market slack is changing." },
  { id: "forecaster", name: "Model-Based Forecaster", rule: "Forecast targeting with the VAR",
    lens: "Picks the move that minimizes the model's projected squared deviations of inflation from 2% and unemployment from its natural rate over 24 months." },
];
export const CHAIR = { id: "chair", name: "Committee Chair", lens: "Synthesizes the discussion and proposes a decision the committee can support." };
export const REFEREE = { id: "referee", name: "Evidence Referee", lens: "Non-voting. Checks each claim against the estimated model." };

const snap = (r0, rate) => r0 + Math.round((rate - r0) / 0.25) * 0.25;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${x.toFixed(2)}%`;
const bp = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)} bp`;

/* ============================ RULES ============================ */

export function rulePrescriptions(model, snapshot = null) {
  const c = model.conditions;
  // Prefer the snapshot's as-published values (ALFRED vintages / BLS) over revised model data.
  const sd = (id) => snapshot?.derived?.find((d) => d.id === id && Number.isFinite(d.value));
  const sPi = sd("corePce"), sU = sd("unemployment");
  const pi = sPi ? sPi.value : c.coreInflation, u = sU ? sU.value : c.unemployment, us = c.naturalUnemployment ?? 4.2;
  const u12 = sU && Number.isFinite(sU.changeYoY) ? sU.value - sU.changeYoY : c.unemployment12mAgo;
  const gap = us - u, gap12 = (c.naturalUnemployment12mAgo ?? us) - u12;
  const dataSource = sPi || sU ? `snapshot (${snapshot.mode === "historical" ? "as first published" : "latest published"}): ${[sPi?.from, sU?.from].filter(Boolean).join(", ")}` : "model data (revised values)";
  const R0 = c.policyRate;
  const taylor = R_STAR + pi + 0.5 * (pi - PI_STAR) + 1.0 * gap;        // output gap ≈ 2·(u*−u) (Okun)
  const balanced = R_STAR + pi + 0.5 * (pi - PI_STAR) + 2.0 * gap;
  const inertial = 0.85 * R0 + 0.15 * balanced;
  const firstDiff = R0 + 0.5 * (pi - PI_STAR) + 2.0 * (gap - gap12);

  // Forecast targeting: evaluate each candidate move with the model.
  const losses = CANDIDATE_MOVES.map(mv => {
    const s = model.scenarios[String(Math.round(mv * 100))];
    let L = 0;
    for (let h = 0; h < model.meta.horizon; h++) L += (s.infl.mean[h] - PI_STAR) ** 2 + (s.u.mean[h] - us) ** 2;
    return { move: mv, loss: L / model.meta.horizon };
  });
  const sorted = [...losses].sort((a, b) => a.loss - b.loss);
  // Only leave the current rate when the model shows a meaningful gain (≥1% lower loss than
  // holding); smaller differences are within the model's noise.
  const holdLoss = losses.find(l => l.move === 0).loss;
  const relGain = holdLoss > 0 ? (holdLoss - sorted[0].loss) / holdLoss : 0;
  const ft = relGain >= MIN_MODEL_GAIN ? sorted[0] : losses.find(l => l.move === 0);
  return {
    inputs: { pi, u, uStar: us, gap: r3(gap), gapChange12m: r3(gap - gap12), R0, rStar: R_STAR, piStar: PI_STAR, dataSource },
    classic: { rule: taylor, formula: `${R_STAR} + π + 0.5(π − 2) + 1.0(u* − u)` },
    balanced: { rule: balanced, formula: `${R_STAR} + π + 0.5(π − 2) + 2.0(u* − u)` },
    gradualist: { rule: inertial, formula: "0.85·R(prev) + 0.15·balanced rule" },
    momentum: { rule: firstDiff, formula: "R(prev) + 0.5(π − 2) + 2·Δ12m(u* − u)" },
    forecaster: { rule: R0 + ft.move, formula: "argmin over moves of mean[(π−2)² + (u−u*)²], 24 months; hold unless ≥1% better than holding", losses,
      relGain },
  };
}

/* ============================ CLAIMS & REFEREE ============================ */

function claimText(cl) {
  if (cl.type === "baseline") return `Without a policy change, ${LABELS[cl.variable]} will go ${cl.direction} over the next ${cl.horizon} months.`;
  return `A ${bp(cl.move_bp / 100)} move will push ${LABELS[cl.variable]} ${cl.direction} within ${cl.horizon} months.`;
}

function templateClaims(model, move) {
  const c = model.conditions;
  if (Math.abs(move) < 0.125) {
    return [{ type: "baseline", variable: "infl", horizon: 12, direction: c.coreInflation > PI_STAR ? "down" : "up" }];
  }
  const m = Math.round(move * 100);
  return move > 0
    ? [{ type: "policy", variable: "infl", horizon: 12, direction: "down", move_bp: m },
       { type: "policy", variable: "u", horizon: 12, direction: "up", move_bp: m }]
    : [{ type: "policy", variable: "u", horizon: 12, direction: "down", move_bp: m },
       { type: "policy", variable: "gdp", horizon: 12, direction: "up", move_bp: m }];
}

export function checkClaim(model, cl) {
  const h = clamp(Math.round(cl.horizon || 12), 1, model.meta.horizon);
  const ev = cl.type === "policy" && cl.move_bp
    ? policyEffectAt(model, cl.move_bp, cl.variable, h)
    : baselineChangeAt(model, cl.variable, h);
  let verdict;
  if (cl.direction === "flat") verdict = ev.lo <= 0 && ev.hi >= 0 && Math.abs(ev.point) < 0.1 ? "supported" : (ev.lo > 0 || ev.hi < 0 ? "contradicted" : "uncertain");
  else {
    const want = cl.direction === "up" ? 1 : -1;
    if (want * ev.lo > 0 && want * ev.hi > 0) verdict = "supported";
    else if (want * ev.lo < 0 && want * ev.hi < 0) verdict = "contradicted";
    else verdict = "uncertain";
  }
  const what = cl.type === "policy" ? `${bp(cl.move_bp / 100)} → change in ${LABELS[cl.variable]}` : `baseline change in ${LABELS[cl.variable]}`;
  const evidence = `Model: ${what} after ${h} months ≈ ${ev.point >= 0 ? "+" : ""}${ev.point.toFixed(2)} pp (80% range ${ev.lo.toFixed(2)} to ${ev.hi.toFixed(2)}).`;
  const explain = verdict === "supported" ? "The whole 80% range points the claimed way."
    : verdict === "contradicted" ? "The whole 80% range points the opposite way — the claim conflicts with the estimated model."
    : "The 80% range includes both directions — this is genuine uncertainty, not an error.";
  return { ...cl, horizon: h, text: cl.text || claimText(cl), verdict, evidence, explain, modelPoint: r3(ev.point), modelLo: r3(ev.lo), modelHi: r3(ev.hi) };
}

/* ============================ DEMO (RULE-BASED) AGENTS ============================ */

function demoInitial(model, rules) {
  const c = model.conditions, R0 = c.policyRate;
  return MEMBERS.map(m => {
    const target = Math.max(0.125, rules[m.id].rule);
    const rate = R0 + clamp(target - R0, -MAX_STEP, MAX_STEP);
    const conf = m.id === "forecaster"
      ? clamp(0.55 + 0.3 * Math.min(1, rules.forecaster.relGain / 0.05), 0.55, 0.85)
      : clamp(0.6 + 0.25 * Math.min(1, Math.abs(target - R0) / MAX_STEP), 0.6, 0.85);
    const move = snap(R0, rate) - R0;
    const capped = Math.abs(target - R0) > MAX_STEP ? ` Limiting moves to 50 bp per meeting, I recommend ${pct(rate)}.` : "";
    const summary = m.id === "forecaster"
      ? (Math.abs(move) < 0.125
          ? `Comparing the model's 24-month projections, no option beats holding by a meaningful margin, so I recommend holding.`
          : `Comparing the model's 24-month projections for each option, a ${bp(move)} move gives the smallest combined miss on inflation and unemployment.`)
      : `Core inflation is ${pct(c.coreInflation)} against a 2% target and unemployment is ${pct(c.unemployment)} versus an estimated natural rate of ${pct(rules.inputs.uStar)}. The ${m.rule} prescribes ${pct(target)}.${capped}`;
    return { id: m.id, rate: r3(rate), confidence: r3(conf), summary, claims: templateClaims(model, move), source: "rule" };
  });
}

function demoDebate(initial, checksByMember) {
  const sig = (p) => KAPPA * (1 - p.confidence) / p.confidence;
  return initial.map(p => {
    const ownBad = checksByMember[p.id].some(c => c.verdict === "contradicted");
    const si = sig(p) * (ownBad ? 1.5 : 1);
    let num = p.rate / si ** 2, den = 1 / si ** 2;
    for (const q of initial) {
      if (q.id === p.id) continue;
      const qBad = checksByMember[q.id].some(c => c.verdict === "contradicted");
      const sj2 = (sig(q) ** 2 / PERSUASION) * (qBad ? 2 : 1);
      num += q.rate / sj2; den += 1 / sj2;
    }
    const rate = r3(num / den);
    const moved = rate - p.rate;
    const why = Math.abs(moved) < 0.01 ? "I keep my position." :
      `Weighing the others' arguments${ownBad ? " and the referee's challenge to my own claim" : ""}, I move ${moved > 0 ? "up" : "down"} ${Math.abs(Math.round(moved * 100))} bp to ${pct(rate)}.`;
    return { id: p.id, rate, confidence: r3(Math.min(0.9, p.confidence + 0.03)), summary: why, claims: [], source: "rule" };
  });
}

/* ============================ LIVE (CLAUDE) AGENTS ============================ */

const POSITION_TOOL = {
  name: "submit_position",
  description: "Submit your policy position for this round.",
  input_schema: {
    type: "object",
    properties: {
      recommended_rate: { type: "number", description: "Preferred target-range midpoint in percent, e.g. 3.875" },
      confidence: { type: "number", description: "0 to 1" },
      summary: { type: "string", description: "Your argument in plain English for a non-economist, at most 90 words. Cite model numbers from the briefing; do not invent forecasts." },
      changed_because: { type: "string", description: "Round 2 only: why you changed (or kept) your position" },
      claims: {
        type: "array", maxItems: 3,
        description: "Checkable claims your argument relies on",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            type: { type: "string", enum: ["policy", "baseline"] },
            variable: { type: "string", enum: ["infl", "u", "ip", "gdp", "ffr"] },
            direction: { type: "string", enum: ["up", "down", "flat"] },
            horizon: { type: "integer", description: "months, 1-24" },
            move_bp: { type: "number", description: "policy claims only: size of the rate change in bp" },
          },
          required: ["text", "type", "variable", "direction", "horizon"],
        },
      },
    },
    required: ["recommended_rate", "confidence", "summary", "claims"],
  },
};

const PROPOSAL_TOOL = {
  name: "submit_proposal",
  description: "Propose the committee's decision.",
  input_schema: {
    type: "object",
    properties: {
      proposed_rate: { type: "number", description: "Target-range midpoint in percent; must be the current rate plus a multiple of 0.25 within ±0.50" },
      rationale: { type: "string", description: "At most 110 words, plain English" },
    },
    required: ["proposed_rate", "rationale"],
  },
};

// Provider: Claude if ANTHROPIC_API_KEY is set, else OpenAI if OPENAI_API_KEY is set.
export function llmProvider(env) {
  if (env.ANTHROPIC_API_KEY) return { name: "anthropic", model: env.LAB_MODEL || "claude-sonnet-5-5" };
  if (env.OPENAI_API_KEY) return { name: "openai", model: env.LAB_OPENAI_MODEL || "gpt-4o-mini" };
  return null;
}

export async function callLLM(env, usage, system, user, tool) { return callClaude(env, usage, system, user, tool); }

async function callClaude(env, usage, system, user, tool) {
  const prov = llmProvider(env);
  const p = prices(env);
  const estIn = (system.length + user.length + JSON.stringify(tool).length) / 4;
  await reserve(env, (estIn * p.llmIn + 900 * p.llmOut) / 1e6, `${prov.name} call`);
  const isOpenAI = prov.name === "openai";
  const res = await fetch(isOpenAI ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: isOpenAI
      ? { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }
      : { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(isOpenAI
      ? { model: prov.model, max_tokens: 900, temperature: 0.4,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
          tool_choice: { type: "function", function: { name: tool.name } } }
      : { model: prov.model, max_tokens: 900, temperature: 0.4,
          system, messages: [{ role: "user", content: user }],
          tools: [tool], tool_choice: { type: "tool", name: tool.name } }),
    signal: AbortSignal.timeout(Number(env.LAB_LLM_TIMEOUT_MS || 45000)),
  });
  if (!res.ok) throw new Error(`${prov.name} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  usage.calls++;
  const inTok = (isOpenAI ? data.usage?.prompt_tokens : data.usage?.input_tokens) || estIn;
  const outTok = (isOpenAI ? data.usage?.completion_tokens : data.usage?.output_tokens) || 900;
  await record(env, (inTok * p.llmIn + outTok * p.llmOut) / 1e6);
  if (isOpenAI) {
    usage.input += data.usage?.prompt_tokens || 0; usage.output += data.usage?.completion_tokens || 0;
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) throw new Error("OpenAI returned no structured output");
    return JSON.parse(args);
  }
  usage.input += data.usage?.input_tokens || 0; usage.output += data.usage?.output_tokens || 0;
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (!block) throw new Error("Claude returned no structured output");
  return block.input;
}

function briefing(model, rules, snapshot = null) {
  const c = model.conditions, s = model.scenarios;
  const row = (mv) => {
    const k = String(Math.round(mv * 100));
    const f = (v, h) => `${s[k][v].mean[h - 1].toFixed(2)} [${s[k][v].p10[h - 1].toFixed(2)}–${s[k][v].p90[h - 1].toFixed(2)}]`;
    return `  ${bp(mv).padEnd(7)} | infl@12m ${f("infl", 12)} | unemp@12m ${f("u", 12)} | GDP@12m ${f("gdp", 12)} | infl@24m ${f("infl", 24)} | unemp@24m ${f("u", 24)}`;
  };
  return [
    `SIMULATION — not real Fed policy. Data through ${c.dataMonth}.`,
    `Current target-range midpoint: ${pct(c.policyRate)}. Core PCE inflation ${pct(c.coreInflation)} (12m ago ${pct(c.coreInflation12mAgo)}). Unemployment ${pct(c.unemployment)} (12m ago ${pct(c.unemployment12mAgo)}); CBO natural rate ${pct(rules.inputs.uStar)}. Industrial production growth ${pct(c.ipGrowth)} YoY. Real GDP growth ${c.gdpGrowth != null ? pct(c.gdpGrowth) : "n/a"} YoY.`,
    `Rule prescriptions: Taylor 1993 ${pct(rules.classic.rule)}, balanced ${pct(rules.balanced.rule)}, inertial ${pct(rules.gradualist.rule)}, first-difference ${pct(rules.momentum.rule)}, VAR forecast-targeting ${pct(rules.forecaster.rule)}.`,
    `Estimated VAR projections by move (mean [80% range]), rate held for ${model.meta.holdMonths} months:`,
    ...CANDIDATE_MOVES.map(row),
    `Model caveat: the policy effect on unemployment and growth is statistically uncertain in this model (80% ranges often include zero).`,
    snapshotBriefing(snapshot),
  ].filter(Boolean).join("\n");
}

function memberSystem(m) {
  return `You are the "${m.name}" on a simulated monetary policy committee in a university research tool. You are an analytical perspective, not a real Federal Reserve official.
Your lens: ${m.lens} Your anchor is the ${m.rule}; you may deviate from it if the evidence warrants, but explain why.
Rules: recommend a rate within ±0.50 pp of the current rate. Base numbers only on the briefing; never invent forecasts. State claims precisely enough that a referee can check them against the model. Write for a student with no economics background.`;
}

async function liveRound(env, usage, model, rules, round, prior, checks, snapshot) {
  const brief = briefing(model, rules, snapshot);
  return Promise.all(MEMBERS.map(async (m) => {
    let user = `BRIEFING\n${brief}\n\nYour rule prescribes ${pct(rules[m.id].rule)} (${rules[m.id].formula}).`;
    if (round === 1) user += `\n\nRound 1 (independent analysis): give your recommendation without knowing the others' views.`;
    else {
      user += `\n\nRound 2 (debate). Round-1 positions:\n` + prior.map(p => {
        const mm = MEMBERS.find(x => x.id === p.id);
        const cs = checks[p.id].map(c => `    - claim: "${c.text}" → referee: ${c.verdict.toUpperCase()}. ${c.evidence}`).join("\n");
        return `* ${mm.name}: ${pct(p.rate)} (confidence ${p.confidence}). ${p.summary}\n${cs}`;
      }).join("\n") + `\n\nReconsider your position in light of these arguments and the referee's checks. Challenge any argument you think is wrong. Fill in changed_because.`;
    }
    try {
      const out = await callClaude(env, usage, memberSystem(m), user, POSITION_TOOL);
      let rate = Number(out.recommended_rate), conf = Number(out.confidence);
      if (!Number.isFinite(rate)) throw new Error("bad rate");
      if (conf > 1) conf /= 100;
      const R0 = model.conditions.policyRate;
      const asked = rate;
      rate = clamp(rate, Math.max(0.125, R0 - MAX_STEP), R0 + MAX_STEP);
      const capNote = Math.abs(asked - rate) > 0.005 ? ` [Asked for ${pct(asked)}; capped at ${pct(rate)} by the ±50 bp-per-meeting rule.]` : "";
      const claims = (out.claims || []).slice(0, 3).filter(c => LABELS[c.variable] && ["up", "down", "flat"].includes(c.direction))
        .map(c => ({ ...c, type: c.type === "policy" && Number(c.move_bp) ? "policy" : "baseline", move_bp: Number(c.move_bp) || undefined }));
      return {
        id: m.id, rate: r3(rate), confidence: r3(clamp(Number.isFinite(conf) ? conf : 0.6, 0.3, 0.95)),
        summary: String(out.summary || "").slice(0, 900) + (round === 2 && out.changed_because ? ` ${String(out.changed_because).slice(0, 400)}` : "") + capNote,
        claims, source: "ai",
      };
    } catch (e) {
      // Agent failure: fall back to the member's rule-based position and say so.
      const fb = round === 1 ? demoInitial(model, rules).find(p => p.id === m.id) : { ...prior.find(p => p.id === m.id), claims: [] };
      return { ...fb, source: "fallback", error: String(e.message || e).slice(0, 160) };
    }
  }));
}

/* ============================ MEETING ============================ */

function vote(positions, proposal, R0) {
  const ballots = positions.map(p => ({ id: p.id, pref: p.rate, vote: Math.abs(p.rate - proposal) >= DISSENT_GAP - 1e-9 ? "dissent" : "aye" }));
  ballots.push({ id: CHAIR.id, pref: proposal, vote: "aye" });
  const dissents = ballots.filter(b => b.vote === "dissent").length;
  const passed = dissents * 2 <= ballots.length; // fails only if a strict majority dissents
  const decision = passed ? proposal : snap(R0, median(positions.map(p => p.rate)));
  return { ballots, dissents, passed, decision: r3(decision) };
}

export async function runMeeting(env, model, { mode = "auto", snapshot = null } = {}) {
  const prov = llmProvider(env);
  const live = !!prov && mode !== "demo";
  const usage = { calls: 0, input: 0, output: 0 };
  const R0 = model.conditions.policyRate;
  const rules = rulePrescriptions(model, snapshot);
  const transcript = [];
  const say = (e) => transcript.push(e);

  say({ step: "conditions", speaker: CHAIR.id, text: `This is a simulated meeting. Core inflation is ${pct(model.conditions.coreInflation)}, unemployment ${pct(model.conditions.unemployment)}, and the policy rate ${pct(R0)}. The question is whether to move rates, and by how much.` });

  // Round 1 — independent positions
  const initial = live ? await liveRound(env, usage, model, rules, 1, null, null, snapshot) : demoInitial(model, rules);
  const checks1 = Object.fromEntries(initial.map(p => [p.id, p.claims.map(c => checkClaim(model, c))]));
  initial.forEach(p => say({ step: "round1", speaker: p.id, rate: p.rate, confidence: p.confidence, text: p.summary, source: p.source, error: p.error }));
  say({ step: "referee", speaker: REFEREE.id, checks: Object.entries(checks1).flatMap(([id, cs]) => cs.map(c => ({ member: id, ...c }))),
    text: "I checked each claim against the estimated model." });

  // Track A — no debate
  const propA = r3(snap(R0, median(initial.map(p => p.rate))));
  const voteA = vote(initial, propA, R0);

  // Track B — debate
  const final = live ? await liveRound(env, usage, model, rules, 2, initial, checks1, snapshot) : demoDebate(initial, checks1);
  const checks2 = Object.fromEntries(final.map(p => [p.id, p.claims.map(c => checkClaim(model, c))]));
  final.forEach(p => say({ step: "round2", speaker: p.id, rate: p.rate, confidence: p.confidence, text: p.summary, source: p.source, error: p.error,
    from: initial.find(q => q.id === p.id).rate }));
  if (Object.values(checks2).some(cs => cs.length)) {
    say({ step: "referee", speaker: REFEREE.id, checks: Object.entries(checks2).flatMap(([id, cs]) => cs.map(c => ({ member: id, ...c }))),
      text: "Second-round claims, checked against the model." });
  }

  // Chair proposal
  let proposal = r3(snap(R0, median(final.map(p => p.rate)))), rationale, chairSource = "rule";
  if (live) {
    try {
      const user = `${briefing(model, rules, snapshot)}\n\nFinal member positions:\n` + final.map(p => `* ${MEMBERS.find(m => m.id === p.id).name}: ${pct(p.rate)} — ${p.summary}`).join("\n") +
        `\n\nVoting rule: ${VOTING_RULE}\nPropose the decision.`;
      const out = await callClaude(env, usage, `You chair a simulated monetary policy committee in a university research tool (not the real Fed). ${CHAIR.lens} Write for a student with no economics background.`, user, PROPOSAL_TOOL);
      const pr = Number(out.proposed_rate);
      if (Number.isFinite(pr)) { proposal = r3(snap(R0, clamp(pr, R0 - MAX_STEP, R0 + MAX_STEP))); rationale = String(out.rationale || "").slice(0, 1000); chairSource = "ai"; }
    } catch (e) { rationale = `(Chair agent failed: ${String(e.message || e).slice(0, 120)}; using the median rule.)`; }
  }
  if (!rationale || chairSource !== "ai") {
    rationale = (rationale ? rationale + " " : "") + `The middle of the committee's final views is ${pct(median(final.map(p => p.rate)))}; I propose ${pct(proposal)} (${bp(proposal - R0)}).`;
  }
  say({ step: "proposal", speaker: CHAIR.id, rate: proposal, text: rationale, source: chairSource });

  const voteB = vote(final, proposal, R0);
  say({ step: "vote", speaker: CHAIR.id, text: voteB.passed
    ? `The proposal passes with ${voteB.dissents} dissent${voteB.dissents === 1 ? "" : "s"}. Decision: ${pct(voteB.decision)} (${bp(voteB.decision - R0)}).`
    : `The proposal fails (${voteB.dissents} dissents). By rule the decision falls back to the median view: ${pct(voteB.decision)}.` });

  const moveKey = (rate) => String(Math.round(clamp(rate - R0, -0.5, 0.5) * 100));
  const shifts = final.map(p => p.rate - initial.find(q => q.id === p.id).rate);

  return {
    disclaimer: "Simulation for research and teaching. Not an official Federal Reserve forecast or decision.",
    mode: live ? "live" : "demo",
    modeNote: live
      ? `Members and Chair are AI agents (${prov.name} ${prov.model}). Votes and the referee are deterministic.`
      : "Demo mode: no AI API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY). Members' positions come from their policy rules and 'debate' uses a documented Bayesian persuasion rule, not AI conversation.",
    usage: live ? { ...usage, note: "Token counts for this meeting; multiply by your model's per-token price for cost." } : null,
    votingRule: VOTING_RULE,
    members: [...MEMBERS, CHAIR, REFEREE].map(({ id, name, lens, rule }) => ({ id, name, lens, rule: rule || null })),
    rules,
    initial, final, transcript,
    dataSnapshot: snapshot ? { cutoff: snapshot.cutoff, mode: snapshot.mode, issues: snapshot.issues.length } : null,
    checks: [...Object.entries(checks1).flatMap(([id, cs]) => cs.map(c => ({ member: id, round: 1, ...c }))),
             ...Object.entries(checks2).flatMap(([id, cs]) => cs.map(c => ({ member: id, round: 2, ...c })))],
    decision: { rate: voteB.decision, move: r3(voteB.decision - R0), scenarioKey: moveKey(voteB.decision), proposal, passed: voteB.passed, ballots: voteB.ballots, dissents: voteB.dissents },
    comparison: {
      noDebate: { rate: voteA.decision, move: r3(voteA.decision - R0), scenarioKey: moveKey(voteA.decision), dissents: voteA.dissents, rule: "Median of initial recommendations, rounded to 25 bp; voted on with initial preferences." },
      debate: { rate: voteB.decision, move: r3(voteB.decision - R0), scenarioKey: moveKey(voteB.decision), dissents: voteB.dissents },
      modelOnly: { rate: r3(rules.forecaster.rule), move: r3(rules.forecaster.rule - R0), scenarioKey: moveKey(rules.forecaster.rule) },
      sameDecision: Math.abs(voteA.decision - voteB.decision) < 1e-9,
      dispersionBefore: r3(sd(initial.map(p => p.rate))), dispersionAfter: r3(sd(final.map(p => p.rate))),
      membersChanged: shifts.filter(x => Math.abs(x) >= 0.05).length,
      meanAbsShift: r3(shifts.reduce((a, b) => a + Math.abs(b), 0) / shifts.length),
      contradictedClaims: Object.values(checks1).flat().filter(c => c.verdict === "contradicted").length,
    },
  };
}

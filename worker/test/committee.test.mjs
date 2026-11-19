// Run: node test/committee.test.mjs   (uses live FRED data; Claude API is mocked)
import assert from "node:assert/strict";
import { buildLabModel } from "../src/lab/model.js";
import { runMeeting, checkClaim } from "../src/lab/committee.js";
import worker from "../src/worker.js";

const model = await buildLabModel({}, {});
const R0 = model.conditions.policyRate;

// 1. Demo meeting
const demo = await runMeeting({}, model, {});
assert.equal(demo.mode, "demo");
assert.equal(demo.initial.length, 5); assert.equal(demo.final.length, 5);
assert.equal(demo.decision.ballots.length, 6);
assert.ok(Math.abs(((demo.decision.rate - R0) / 0.25) % 1) < 1e-9, "decision on 25bp grid");
assert.ok(Math.abs(demo.decision.move) <= 0.5);
for (const k of [demo.decision.scenarioKey, demo.comparison.noDebate.scenarioKey]) assert.ok(model.scenarios[k], `scenario ${k}`);
console.log("DEMO decision", demo.decision.rate, "move", demo.decision.move, "dissents", demo.decision.dissents,
  "| noDebate", demo.comparison.noDebate.rate, "| modelOnly", demo.comparison.modelOnly.rate);
console.log("initial", demo.initial.map(p => `${p.id}:${p.rate}`).join(" "));
console.log("final  ", demo.final.map(p => `${p.id}:${p.rate}`).join(" "));
console.log("checks", demo.checks.map(c => `${c.member}/${c.variable}/${c.direction}:${c.verdict}`).join(" "));

// 2. Referee logic on synthetic bands
const fake = { meta: { horizon: 24 }, scenarios: { "25": { u: { effect: Array(24).fill(0.1), effectLo: Array(24).fill(0.05), effectHi: Array(24).fill(0.2) } } } };
assert.equal(checkClaim(fake, { type: "policy", variable: "u", direction: "up", horizon: 12, move_bp: 25 }).verdict, "supported");
assert.equal(checkClaim(fake, { type: "policy", variable: "u", direction: "down", horizon: 12, move_bp: 25 }).verdict, "contradicted");
assert.equal(checkClaim(fake, { type: "policy", variable: "u", direction: "up", horizon: 12, move_bp: -25 }).verdict, "contradicted");

// 3. Live mode with mocked Claude: one member fails, others return structured output
let n = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
  n++;
  const body = JSON.parse(init.body);
  assert.equal(body.tool_choice.type, "tool");
  if (body.system.includes("Momentum")) return new Response("overloaded", { status: 529 });
  const input = body.tools[0].name === "submit_proposal"
    ? { proposed_rate: R0 + 0.3, rationale: "Mock chair rationale." }
    : { recommended_rate: R0 + 0.25, confidence: 70, summary: "Mock argument.",
        claims: [{ text: "Hike lowers inflation", type: "policy", variable: "infl", direction: "down", horizon: 12, move_bp: 25 }] };
  return new Response(JSON.stringify({ content: [{ type: "tool_use", input }], usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200 });
};
const live = await runMeeting({ ANTHROPIC_API_KEY: "test" }, model, {});
assert.equal(live.mode, "live"); assert.equal(n, 11); // 5 + 5 + chair
assert.equal(live.initial.find(p => p.id === "momentum").source, "fallback");
assert.equal(live.decision.proposal, Math.round((R0 + 0.25) * 1000) / 1000, "chair proposal snapped to grid");
assert.equal(live.usage.calls, 9);
assert.ok(live.initial.every(p => p.confidence <= 0.95));
console.log("LIVE(mock) decision", live.decision.rate, "dissents", live.decision.dissents, "usage", live.usage);

// 4. Worker routes
globalThis.fetch = realFetch;
const res = await worker.fetch(new Request("http://x/lab/meeting", { method: "POST", body: JSON.stringify({ mode: "demo" }) }), {});
assert.equal(res.status, 200);
const j = await res.json(); assert.ok(j.model && j.meeting);
const hist = await worker.fetch(new Request("http://x/lab/model?asOf=2022-06-01"), {});
const hj = await hist.json(); assert.equal(hist.status, 200, JSON.stringify(hj).slice(0, 200));
assert.ok(hj.model.conditions.dataMonth < "2022-06", "historical mode must not use later data");
console.log("historical 2022-06-01: data month", hj.model.conditions.dataMonth, "policy rate", hj.model.conditions.policyRate, "core infl", hj.model.conditions.coreInflation);
console.log("ALL TESTS PASSED");

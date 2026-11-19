// Small no-cost smoke test: builds one cutoff-safe data snapshot from the free official sources
// (ALFRED/FRED, BLS, federalreserve.gov) and runs ONE demo (rule-based) meeting. Paid calls are
// disabled (LAB_PAID_CALLS=off), so this costs $0.
// Usage: node worker/scripts/smoke.mjs [YYYY-MM-DD]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../src/lab/snapshot.js";
import { buildLabModel } from "../src/lab/model.js";
import { runMeeting } from "../src/lab/committee.js";

const asOf = process.argv[2] || null;
const dir = process.env.LAB_CACHE_DIR || join(homedir(), ".cache", "us-macro-dashboard"); // outside the project (Live Server)
await mkdir(dir, { recursive: true });
const f = (k) => join(dir, createHash("sha256").update(k).digest("hex").slice(0, 32) + ".json");
const env = { LAB_PAID_CALLS: "off", BLS_API_KEY: process.env.BLS_API_KEY,
  LAB_CACHE: { get: async (k) => { try { return JSON.parse(await readFile(f(k), "utf8")); } catch { return null; } }, put: (k, v) => writeFile(f(k), JSON.stringify(v)) } };

const t0 = Date.now();
const snap = await buildSnapshot(env, { asOf });
console.log(`Snapshot cutoff ${snap.cutoff} (${snap.mode}) in ${Date.now() - t0} ms`);
for (const d of snap.derived) console.log(`  ${d.group.padEnd(20)} ${d.label.padEnd(36)} ${String(d.value).padStart(9)}  obs ${d.observationDate}  ← ${d.from}`);
console.log(`  BLS records: ${snap.raw.labor.map((r) => `${r.seriesId}=${r.value}@${r.observationDate}`).join(", ") || "none"}`);
console.log(`  Statement: ${snap.raw.statement ? `${snap.raw.statement.date} ${snap.raw.statement.url}\n    "${snap.raw.statement.decisionParagraph.slice(0, 200)}…"` : "none"}`);
console.log(`  Speeches: ${snap.raw.speeches.length}`); snap.raw.speeches.forEach((s) => console.log(`    ${s.date} ${s.speaker} — ${s.title.slice(0, 60)} [text ${s.textAvailable ? "ok" : "unavailable"}]`));
console.log(`  Issues (${snap.issues.length}):`); snap.issues.forEach((i) => console.log(`    [${i.kind}] ${i.source}: ${i.message}`));
const model = await buildLabModel(env, { asOf });
const m = await runMeeting(env, model, { mode: "demo", snapshot: snap });
console.log(`Demo meeting: rule inputs from ${m.rules.inputs.dataSource}; π=${m.rules.inputs.pi}, u=${m.rules.inputs.u}; decision ${m.decision.rate}% (${Math.round(m.decision.move * 100)} bp), ${m.decision.dissents} dissent(s). Paid calls: 0.`);

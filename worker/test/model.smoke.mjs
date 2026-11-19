import { buildLabModel, policyEffectAt } from "../src/lab/model.js";
const t0 = Date.now();
const m = await buildLabModel({}, { asOf: process.argv[2] || null });
console.log("ms", Date.now() - t0, JSON.stringify(m.meta, null, 0).slice(0, 600));
console.log("conditions", m.conditions);
for (const k of ["infl", "u", "ip", "gdp", "ffr"]) {
  const s = m.scenarios["25"][k];
  console.log(k, "+25bp effect @6/12/24:", [5, 11, 23].map(h => `${s.effect[h]} [${s.effectLo[h]},${s.effectHi[h]}]`).join("  "),
    "| base@12", m.scenarios["0"][k].mean[11], `[${m.scenarios["0"][k].p10[11]},${m.scenarios["0"][k].p90[11]}]`);
}
console.log(policyEffectAt(m, 50, "u", 12));

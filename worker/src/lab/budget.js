// lab/budget.js — global cap on paid API spending (LLM + text-to-speech).
//  * Every paid call first checks `reserve(estimate)`; if spent + estimate would exceed
//    LAB_BUDGET_USD (default $5), the call is refused BEFORE any request is sent.
//  * Spending is estimated from token/character counts × list prices (env-overridable).
//  * Persistence: memory, plus env.LAB_CACHE when provided (the local dev server stores it on
//    disk, so the total survives restarts). On Cloudflare the counter is per isolate — set a
//    hard limit in the provider dashboard as well; this cap is a safeguard, not billing truth.
//  * LAB_PAID_CALLS=off disables all paid calls (no-cost mode).

const KEY = "budget|spent";
let memorySpent = null;

export class BudgetError extends Error {
  constructor(message) { super(message); this.name = "BudgetError"; this.status = 402; }
}

export function prices(env = {}) {
  const anthropic = !!env.ANTHROPIC_API_KEY;
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    // gpt-4o-mini list prices; for Claude a conservative default unless overridden
    llmIn: n(env.LAB_LLM_USD_PER_1M_IN, anthropic ? 3 : 0.15),
    llmOut: n(env.LAB_LLM_USD_PER_1M_OUT, anthropic ? 15 : 0.60),
    ttsPer1kChars: n(env.LAB_TTS_USD_PER_1K_CHARS, 0.015),
    limit: n(env.LAB_BUDGET_USD, 5),
  };
}

async function load(env) {
  if (memorySpent != null) return memorySpent;
  let v = 0;
  if (env.LAB_CACHE) { try { v = Number((await env.LAB_CACHE.get(KEY))?.value?.spent) || 0; } catch { v = 0; } }
  memorySpent = v;
  return v;
}

export async function budgetStatus(env = {}) {
  const spent = await load(env), p = prices(env);
  return { spentUsd: Math.round(spent * 1e5) / 1e5, limitUsd: p.limit, remainingUsd: Math.max(0, Math.round((p.limit - spent) * 1e5) / 1e5), paidCalls: env.LAB_PAID_CALLS !== "off" };
}

export async function reserve(env = {}, estimateUsd, what = "paid call") {
  if (env.LAB_PAID_CALLS === "off") throw new BudgetError(`Paid calls are disabled (LAB_PAID_CALLS=off); ${what} skipped.`);
  const spent = await load(env), { limit } = prices(env);
  if (spent + estimateUsd > limit) throw new BudgetError(`Spending cap reached: ≈$${spent.toFixed(4)} of $${limit.toFixed(2)} used; ${what} (≈$${estimateUsd.toFixed(4)}) not sent.`);
}

export async function record(env = {}, usd) {
  const spent = (await load(env)) + Math.max(0, usd || 0);
  memorySpent = spent;
  if (env.LAB_CACHE) { try { await env.LAB_CACHE.put(KEY, { value: { spent }, retrievedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
  return spent;
}

export function _resetBudgetForTests() { memorySpent = null; }

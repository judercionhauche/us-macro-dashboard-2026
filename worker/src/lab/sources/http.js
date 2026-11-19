// sources/http.js — shared fetch + cache helpers for the data adapters.
//  * fetchText: per-request timeout, at most `retries` retries on network errors, 429 and 5xx,
//    exponential backoff. Never retries 4xx (bad request / not found).
//  * cached: memory cache plus an optional persistent store injected as env.LAB_CACHE
//    ({ get(key) -> value|null, put(key, value) }) — the local dev server provides a disk store.
//    Records keep their original retrievedAt so provenance survives cache hits.

export class SourceError extends Error {
  constructor(message, { status = null, source = null, url = null } = {}) {
    super(message); this.name = "SourceError"; this.status = status; this.source = source; this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { env = {}, init = {}, timeoutMs, retries = 2, source = null } = {}) {
  const timeout = Number(timeoutMs ?? env.LAB_HTTP_TIMEOUT_MS ?? 20000);
  const backoff = Number(env.LAB_HTTP_BACKOFF_MS ?? 600);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal, headers: { "User-Agent": "us-macro-dashboard research tool", ...(init.headers || {}) } });
      if (res.ok) return await res.text();
      lastErr = new SourceError(`${source || "HTTP"} ${res.status} for ${redact(url)}`, { status: res.status, source, url: redact(url) });
      if (res.status !== 429 && res.status < 500) throw lastErr; // not retryable
    } catch (e) {
      if (e instanceof SourceError && e.status && e.status !== 429 && e.status < 500) throw e;
      lastErr = e.name === "AbortError" ? new SourceError(`${source || "HTTP"} timeout after ${timeout} ms for ${redact(url)}`, { source, url: redact(url) }) : (e instanceof SourceError ? e : new SourceError(`${source || "HTTP"} network error: ${e.message}`, { source, url: redact(url) }));
    } finally { clearTimeout(timer); }
    if (attempt < retries) await sleep(backoff * 2 ** attempt);
  }
  throw lastErr;
}

// Strip credentials from URLs before they reach logs, errors or citations.
export function redact(url) {
  return String(url).replace(/(api_key|registrationkey|key)=[^&]+/gi, "$1=REDACTED");
}

const memory = new Map();
export async function cached(env, key, ttlMs, loader) {
  const now = Date.now();
  const fresh = (rec) => rec && (ttlMs === Infinity || now - Date.parse(rec.retrievedAt) < ttlMs);
  let rec = memory.get(key);
  if (!fresh(rec) && env.LAB_CACHE) {
    try { rec = await env.LAB_CACHE.get(key); } catch { rec = null; }
  }
  if (fresh(rec)) { memory.set(key, rec); return { ...rec, cached: true }; }
  const value = await loader();
  rec = { value, retrievedAt: new Date(now).toISOString() };
  memory.set(key, rec);
  if (env.LAB_CACHE) { try { await env.LAB_CACHE.put(key, rec); } catch { /* cache is best-effort */ } }
  return { ...rec, cached: false };
}
export function _clearMemoryCache() { memory.clear(); }

// Date helpers (ISO yyyy-mm-dd strings)
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); }

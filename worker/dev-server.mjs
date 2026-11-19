// Local development server: serves the dashboard's static files and routes API paths
// to the Cloudflare Worker code, so the full app runs without wrangler.
// Usage: node worker/dev-server.mjs [port]   then open http://localhost:8787/?api=http://localhost:8787
// Optional env: FRED_API_KEY, ANTHROPIC_API_KEY, LAB_MODEL (same names as the worker secrets).
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/worker.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.argv[2] || 8787);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
// Secrets: worker/.dev.vars (KEY=value lines, git-ignored; same file wrangler dev uses), then the shell.
const devVars = {};
try {
  for (const line of (await readFile(new URL("./.dev.vars", import.meta.url), "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && m[2]) devVars[m[1]] = m[2];
  }
} catch { /* no .dev.vars file */ }
const env = Object.fromEntries(["FRED_API_KEY", "ANTHROPIC_API_KEY", "LAB_MODEL", "LAB_OPENAI_MODEL", "OPENAI_API_KEY", "LAB_BOOT_REPS",
  "BLS_API_KEY", "LAB_BUDGET_USD", "LAB_PAID_CALLS", "LAB_VOICE_DEBATE_MAX_USD", "LAB_VOICE_TOTAL_MAX_USD"]
  .filter(k => devVars[k] || process.env[k]).map(k => [k, devVars[k] || process.env[k]]));
// Persistent disk cache for source data + the spending counter.
// Kept OUTSIDE the project folder: writes inside the workspace make VS Code Live Server reload the page.
const CACHE_DIR = process.env.LAB_CACHE_DIR || join(homedir(), ".cache", "us-macro-dashboard");
await mkdir(CACHE_DIR, { recursive: true });
const cacheFile = (k) => join(CACHE_DIR, createHash("sha256").update(k).digest("hex").slice(0, 32) + ".json");
env.LAB_CACHE = {
  async get(k) { try { return JSON.parse(await readFile(cacheFile(k), "utf8")); } catch { return null; } },
  async put(k, v) { await writeFile(cacheFile(k), JSON.stringify(v)); },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/lab/") || ["/forecast", "/meta"].includes(url.pathname)) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(ROOT) || file.includes("/worker/")) { res.writeHead(403); return res.end(); }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }); res.end(body);
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}/?api=http://localhost:${PORT}  (live agents: ${!!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY)}, BLS key: ${!!env.BLS_API_KEY})`));

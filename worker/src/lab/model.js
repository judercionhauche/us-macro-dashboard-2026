// lab/model.js — Estimated macro model for the AI Economic Policy Lab.
// NOTE: identification is by sign restrictions (see identifiedEffects); the recursive
// ordering below is only the Cholesky factor used to parameterize rotations.
//
// A reduced-form VAR estimated by OLS on monthly FRED data, identified recursively
// (Cholesky, ordering: activity, unemployment, inflation, policy rate — the standard
// Christiano–Eichenbaum–Evans assumption that the Fed reacts to same-month data while
// the economy responds to policy with at least a one-month lag).
//
// Policy scenarios hold the fed funds rate Δ above its baseline path for `holdMonths`
// using a sequence of policy shocks (a "modest intervention" conditional forecast), then
// let it evolve endogenously. Uncertainty = analytic forecast-error variance plus
// residual-bootstrap uncertainty about the policy effect.
//
// Everything here is estimated from data; the only fixed choices are documented in
// MODEL_ASSUMPTIONS and returned to the UI.

const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
const FRED_API = "https://api.stlouisfed.org/fred/series/observations";
const CACHE_TTL_MS = 6 * 3600 * 1000;
const fredCache = new Map();
const modelCache = new Map();

// Order matters: it is the recursive identification ordering.
export const MODEL_VARS = [
  { key: "pcom", label: "Commodity prices (PPI)",       unit: "% YoY", src: "PPIACO",   pubLag: 1, yoy: true },
  { key: "ip",   label: "Industrial production growth", unit: "% YoY", src: "INDPRO",   pubLag: 1, yoy: true },
  { key: "u",    label: "Unemployment rate",            unit: "%",     src: "UNRATE",   pubLag: 1, yoy: false },
  { key: "infl", label: "Core PCE inflation",           unit: "% YoY", src: "PCEPILFE", pubLag: 2, yoy: true },
  { key: "ffr",  label: "Effective fed funds rate",     unit: "%",     src: "FEDFUNDS", pubLag: 1, yoy: false },
];
const IDX = Object.fromEntries(MODEL_VARS.map((v, i) => [v.key, i]));
const FFR = IDX.ffr; // index of the policy rate

export const CANDIDATE_MOVES = [-0.5, -0.25, 0, 0.25, 0.5];

export const MODEL_ASSUMPTIONS = [
  "Reduced-form VAR estimated by OLS on monthly data, 1988-01 to 2019-12 (pre-COVID, so pandemic outliers do not dominate the estimates). Lag length chosen by AIC (1–6).",
  "Policy shock identified by sign restrictions (Uhlig 2005): a tightening raises the fed funds rate and does not raise core inflation or commodity prices for 6 months. Unemployment, activity and GDP responses are NOT restricted — they come from the data. (A recursive identification was tested and produced the well-known 'price puzzle', so it is not used.)",
  "Reported policy effects are the median across admissible shocks; for set-identified models the median is a summary across models, not a single structural model (Fry & Pagan 2011).",
  "Policy scenarios keep the fed funds rate a fixed amount above/below baseline for the hold period, then let it follow the model's estimated reaction. This is a conditional forecast, not a structural model of expectations (Lucas critique applies).",
  "GDP is not monthly: GDP effects come from an estimated quarterly bridge regression of real GDP growth on industrial production growth.",
  "Bands are 80% intervals (P10–P90) combining forecast-error variance with bootstrap uncertainty about the policy effect. Parameter uncertainty in the baseline path itself is not included, so bands are somewhat too narrow.",
  "The 2009–2015 zero-lower-bound period is in the sample; the linear model cannot represent the lower bound, which weakens the estimated policy effects.",
];

/* ============================ DATA ============================ */

function parseCsv(text) {
  const out = [];
  const lines = text.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(",");
    const v = Number(raw);
    if (date && raw !== "" && raw !== "." && Number.isFinite(v)) out.push({ date, value: v });
  }
  return out;
}

export async function fetchFred(id, env = {}) {
  const hit = fredCache.get(id);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.obs;

  let obs;
  if (env.FRED_API_KEY) {
    const u = new URL(FRED_API);
    u.searchParams.set("series_id", id);
    u.searchParams.set("api_key", env.FRED_API_KEY);
    u.searchParams.set("file_type", "json");
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`FRED error for ${id}: ${res.status}`);
    const data = await res.json();
    obs = (data.observations || [])
      .filter(o => o.value !== "." && Number.isFinite(Number(o.value)))
      .map(o => ({ date: o.date, value: Number(o.value) }));
  } else {
    // Keyless public CSV endpoint (used for local development / demo mode).
    const res = await fetch(FRED_CSV + encodeURIComponent(id));
    if (!res.ok) throw new Error(`FRED CSV error for ${id}: ${res.status}`);
    obs = parseCsv(await res.text());
  }
  if (!obs.length) throw new Error(`FRED returned no data for ${id}`);
  fredCache.set(id, { t: Date.now(), obs });
  return obs;
}

const ym = (d) => d.slice(0, 7);
function addMonthsYm(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

// A month's value is treated as available on `asOf` only if it was published in a
// month strictly before asOf's month (conservative; latest-revised values, not vintages).
function availableBy(month, pubLag, asOfYm) {
  return !asOfYm || addMonthsYm(month, pubLag) < asOfYm;
}

function lastOnOrBefore(obs, dateStr) {
  let v = null;
  for (const o of obs) { if (o.date <= dateStr) v = o; else break; }
  return v;
}

export async function loadData(env, { asOf = null } = {}) {
  const asOfYm = asOf ? ym(asOf) : null;
  const ids = [...MODEL_VARS.map(v => v.src), "NROU", "GDPC1", "DFEDTARU", "DFEDTARL"];
  if (asOf && asOf < "2008-12-16") ids.push("DFEDTAR");
  const raw = {};
  await Promise.all(ids.map(async id => { raw[id] = await fetchFred(id, env); }));

  // Monthly aligned table
  const perVar = MODEL_VARS.map(v => {
    const m = new Map();
    for (const o of raw[v.src]) {
      const mon = ym(o.date);
      if (availableBy(mon, v.pubLag, asOfYm)) m.set(mon, o.value);
    }
    if (!v.yoy) return m;
    const y = new Map();
    for (const [mon, val] of m) {
      const prev = m.get(addMonthsYm(mon, -12));
      if (prev) y.set(mon, (val / prev - 1) * 100);
    }
    return y;
  });

  let start = "1986-01";
  while (!perVar.every(m => m.has(start))) start = addMonthsYm(start, 1);
  // End at the last month every variable has published; fill isolated internal gaps
  // (e.g. the October 2025 shutdown) by linear interpolation and report them.
  const end = perVar.map(m => [...m.keys()].sort().pop()).sort()[0];
  const months = [], Y = [], filled = [];
  for (let mon = start; mon <= end; mon = addMonthsYm(mon, 1)) {
    const row = perVar.map((m, i) => {
      if (m.has(mon)) return m.get(mon);
      let a = addMonthsYm(mon, -1), b = addMonthsYm(mon, 1), k = 1;
      while (!m.has(b) && k < 3) { b = addMonthsYm(b, 1); k++; }
      if (!m.has(a) || !m.has(b)) return null;
      filled.push(`${MODEL_VARS[i].src} ${mon}`);
      return m.get(a) + (m.get(b) - m.get(a)) / (k + 1);
    });
    if (row.some(v => v == null)) break;
    perVar.forEach((m, i) => m.set(mon, row[i]));
    months.push(mon); Y.push(row);
  }
  if (Y.length < 120) throw new Error("Not enough overlapping monthly data to estimate the model");

  // Policy rate (target midpoint) as of the decision date
  const refDate = asOf || "9999-12-31";
  let policyRate;
  const up = lastOnOrBefore(raw.DFEDTARU, refDate), lo = lastOnOrBefore(raw.DFEDTARL, refDate);
  if (up && lo) policyRate = (up.value + lo.value) / 2;
  else if (raw.DFEDTAR) policyRate = lastOnOrBefore(raw.DFEDTAR, refDate)?.value;
  if (!Number.isFinite(policyRate)) policyRate = Y[Y.length - 1][FFR];

  // CBO natural rate of unemployment (quarterly) at the data origin and 12 months earlier
  const originMonth = months[months.length - 1];
  const nrouAt = (mon) => lastOnOrBefore(raw.NROU, `${mon}-28`)?.value ?? null;

  // GDP YoY (quarterly), restricted to what would have been published (~1 quarter lag)
  const gdpQ = raw.GDPC1.filter(o => availableBy(ym(o.date), 3, asOfYm));
  const gdpYoY = [];
  for (let i = 4; i < gdpQ.length; i++) {
    gdpYoY.push({ q: ym(gdpQ[i].date), v: (gdpQ[i].value / gdpQ[i - 4].value - 1) * 100 });
  }

  return {
    months, Y, originMonth, policyRate,
    nrou: nrouAt(originMonth), nrou12: nrouAt(addMonthsYm(originMonth, -12)),
    gdpYoY, asOf, filled,
  };
}

/* ============================ LINEAR ALGEBRA ============================ */

const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
const eye = (n) => { const m = zeros(n, n); for (let i = 0; i < n; i++) m[i][i] = 1; return m; };
function matMul(A, B) {
  const r = A.length, k = B.length, c = B[0].length, out = zeros(r, c);
  for (let i = 0; i < r; i++) for (let t = 0; t < k; t++) {
    const a = A[i][t]; if (a === 0) continue;
    const Bt = B[t], oi = out[i];
    for (let j = 0; j < c; j++) oi[j] += a * Bt[j];
  }
  return out;
}
const transpose = (A) => A[0].map((_, j) => A.map(r => r[j]));

// Solve A X = B (A square) by Gauss–Jordan with partial pivoting; also returns det(A).
function solve(A, B) {
  const n = A.length, m = B[0].length;
  const M = A.map((r, i) => [...r, ...B[i]]);
  let det = 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error("Singular matrix in VAR estimation");
    if (piv !== col) { [M[piv], M[col]] = [M[col], M[piv]]; det = -det; }
    const p = M[col][col]; det *= p;
    for (let j = col; j < n + m; j++) M[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col]; if (f === 0) continue;
      for (let j = col; j < n + m; j++) M[r][j] -= f * M[col][j];
    }
  }
  return { X: M.map(r => r.slice(n)), det };
}

function cholesky(S) {
  const n = S.length, L = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = S[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) {
      if (s <= 0) throw new Error("Residual covariance not positive definite");
      L[i][i] = Math.sqrt(s);
    } else L[i][j] = s / L[j][j];
  }
  return L;
}

/* ============================ VAR ============================ */

function lagMatrix(Y, p, from = p) {
  const X = [], T = [];
  for (let t = from; t < Y.length; t++) {
    const row = [1];
    for (let l = 1; l <= p; l++) row.push(...Y[t - l]);
    X.push(row); T.push(Y[t]);
  }
  return { X, Yt: T };
}

export function estimateVAR(Y, p, from = p) {
  const n = Y[0].length;
  const { X, Yt } = lagMatrix(Y, p, from);
  const Xt = transpose(X);
  const B = solve(matMul(Xt, X), matMul(Xt, Yt)).X; // k × n
  const T = X.length, k = B.length;
  const fitted = matMul(X, B);
  const resid = Yt.map((r, t) => r.map((v, i) => v - fitted[t][i]));
  const UtU = matMul(transpose(resid), resid);
  const Sigma = UtU.map(r => r.map(v => v / (T - k)));
  const SigmaML = UtU.map(r => r.map(v => v / T));
  const c = B[0].slice();
  const A = [];
  for (let l = 1; l <= p; l++) {
    const Al = zeros(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Al[i][j] = B[1 + (l - 1) * n + j][i];
    A.push(Al);
  }
  return { p, n, T, c, A, Sigma, SigmaML, resid, P: cholesky(Sigma) };
}

function selectLagAIC(Y, maxP = 6) {
  let best = null;
  for (let p = 1; p <= maxP; p++) {
    const v = estimateVAR(Y, p, maxP); // common sample
    const logdet = Math.log(solve(v.SigmaML, eye(v.n)).det);
    const aic = logdet + (2 * p * v.n * v.n) / v.T;
    if (!best || aic < best.aic) best = { p, aic };
  }
  return best.p;
}

function spectralRadius(A) {
  const n = A[0].length, p = A.length, N = n * p;
  let C = zeros(N, N);
  for (let l = 0; l < p; l++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i][l * n + j] = A[l][i][j];
  for (let i = n; i < N; i++) C[i][i - n] = 1;
  // Gelfand's formula: rho = lim ||C^k||^(1/k); k = 2^12 via repeated squaring with rescaling
  let logScale = 0;
  for (let s = 0; s < 12; s++) {
    C = matMul(C, C);
    logScale *= 2;
    const f = Math.sqrt(C.flat().reduce((a, v) => a + v * v, 0)) || 1;
    C = C.map(r => r.map(v => v / f));
    logScale += Math.log(f);
  }
  return Math.exp(logScale / 4096);
}

// Structural MA coefficients Psi_h = Phi_h P, h = 0..H-1
function structuralMA(v, H) {
  const { A, n, p, P } = v;
  const Phi = [eye(n)];
  for (let h = 1; h < H; h++) {
    let acc = zeros(n, n);
    for (let l = 1; l <= Math.min(h, p); l++) {
      const prod = matMul(Phi[h - l], A[l - 1]);
      acc = acc.map((r, i) => r.map((x, j) => x + prod[i][j]));
    }
    Phi.push(acc);
  }
  return { Phi, Psi: Phi.map(F => matMul(F, P)) };
}

// Response of every variable (h = 0..H-1) to holding the policy rate +1pp above
// baseline for `hold` months via a sequence of policy shocks with responses R[h][i].
function unitPolicyEffect(R, hold, H) {
  const n = R[0].length, eps = [];
  for (let h = 0; h < hold; h++) {
    let cum = 0;
    for (let k = 0; k < h; k++) cum += R[h - k][FFR] * eps[k];
    eps.push((1 - cum) / R[0][FFR]);
  }
  return Array.from({ length: H }, (_, h) => {
    const row = new Array(n).fill(0);
    for (let k = 0; k <= Math.min(h, hold - 1); k++) for (let i = 0; i < n; i++) row[i] += R[h - k][i] * eps[k];
    return row;
  });
}

// Sign restrictions (Uhlig 2005): a contractionary policy shock raises the fed funds
// rate and does not raise core inflation or commodity prices for SIGN_MONTHS months.
// Unemployment and activity are left unrestricted ("agnostic").
const SIGN_MONTHS = 6;
function randomNormal(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}
function signIdentifiedShocks(Phi, P, rand, wanted, maxTries) {
  const n = P.length, out = [];
  for (let t = 0; t < maxTries && out.length < wanted; t++) {
    let q = Array.from({ length: n }, () => randomNormal(rand));
    const norm = Math.hypot(...q); q = q.map(x => x / norm);
    let a = P.map(row => row.reduce((acc, x, j) => acc + x * q[j], 0));
    if (a[FFR] < 0) a = a.map(x => -x);
    if (a[FFR] < 0.02) continue; // needs a meaningful rate move on impact
    const R = Phi.map(F => F.map(row => row.reduce((acc, x, j) => acc + x * a[j], 0)));
    let ok = true;
    for (let h = 0; h < SIGN_MONTHS && ok; h++) {
      if (R[h][FFR] < 0 || R[h][IDX.infl] > 0 || R[h][IDX.pcom] > 0) ok = false;
    }
    if (ok) out.push(R);
  }
  return out;
}

function forecastPath(v, Yhist, H) {
  const hist = Yhist.slice(-v.p).map(r => r.slice());
  const out = [];
  for (let h = 0; h < H; h++) {
    const y = v.c.slice();
    for (let l = 1; l <= v.p; l++) {
      const prev = hist[hist.length - l];
      for (let i = 0; i < v.n; i++) for (let j = 0; j < v.n; j++) y[i] += v.A[l - 1][i][j] * prev[j];
    }
    out.push(y); hist.push(y);
  }
  return out;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function identifiedEffects(v, Ysample, hold, H, reps, seed = 20260101) {
  const rand = mulberry32(seed);
  const draws = []; // accepted unit effects, each H × n
  let tries = 0, accepted = 0;
  const collect = (vv) => {
    const { Phi } = structuralMA(vv, H);
    const Rs = signIdentifiedShocks(Phi, vv.P, rand, 5, 400);
    tries++; if (Rs.length) accepted++;
    for (const R of Rs) draws.push(unitPolicyEffect(R, hold, H));
  };
  collect(v);
  for (let r = 0; r < reps; r++) {
    const Ys = Ysample.slice(0, v.p).map(row => row.slice());
    for (let t = v.p; t < Ysample.length; t++) {
      const u = v.resid[Math.floor(rand() * v.resid.length)];
      const y = v.c.slice();
      for (let l = 1; l <= v.p; l++) {
        const prev = Ys[t - l];
        for (let i = 0; i < v.n; i++) for (let j = 0; j < v.n; j++) y[i] += v.A[l - 1][i][j] * prev[j];
      }
      Ys.push(y.map((x, i) => x + u[i]));
    }
    try {
      const vb = estimateVAR(Ys, v.p);
      if (spectralRadius(vb.A) >= 1) continue;
      collect(vb);
    } catch { /* skip degenerate draw */ }
  }
  if (draws.length < 50) throw new Error(`Sign-restricted identification found too few admissible shocks (${draws.length})`);
  const med = zeros(H, v.n), q10 = zeros(H, v.n), q90 = zeros(H, v.n), sd = zeros(H, v.n);
  for (let h = 0; h < H; h++) for (let i = 0; i < v.n; i++) {
    const xs = draws.map(d => d[h][i]).sort((a, b) => a - b);
    med[h][i] = quantile(xs, 0.5); q10[h][i] = quantile(xs, 0.1); q90[h][i] = quantile(xs, 0.9);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    sd[h][i] = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  }
  return { med, q10, q90, sd, draws: draws.length, varDraws: tries, varDrawsWithShock: accepted };
}

// Quarterly bridge: GDP YoY = a + b * IP YoY (quarterly averages), estimated 1988–2019.
function gdpBridge(data) {
  const ipIdx = IDX.ip;
  const ipByQ = new Map();
  data.months.forEach((m, t) => {
    const [y, mo] = m.split("-").map(Number);
    const q = `${y}-${String(Math.floor((mo - 1) / 3) * 3 + 1).padStart(2, "0")}`;
    if (!ipByQ.has(q)) ipByQ.set(q, []);
    ipByQ.get(q).push(data.Y[t][ipIdx]);
  });
  const pts = data.gdpYoY
    .filter(g => g.q >= "1988-01" && g.q <= "2019-10" && ipByQ.get(g.q)?.length === 3)
    .map(g => [ipByQ.get(g.q).reduce((a, b) => a + b, 0) / 3, g.v]);
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const b = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const a = my - b * mx;
  const s = Math.sqrt(pts.reduce((acc, p) => acc + (p[1] - a - b * p[0]) ** 2, 0) / (n - 2));
  const latest = data.gdpYoY[data.gdpYoY.length - 1];
  return { a, b, residSd: s, n, latest };
}

/* ============================ PUBLIC API ============================ */

const Z80 = 1.2815515655446004;
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export async function buildLabModel(env = {}, { asOf = null, holdMonths = 6, horizon = 24, bootReps } = {}) {
  const reps = Number(bootReps ?? env.LAB_BOOT_REPS ?? 200);
  const cacheKey = `${asOf}|${holdMonths}|${horizon}|${reps}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.model;

  const data = await loadData(env, { asOf });
  const H = horizon, hold = Math.max(1, Math.min(holdMonths, H));

  // Estimation sample: 1988-01 .. min(2019-12, last available) — never uses data after asOf.
  const sIdx = data.months.findIndex(m => m >= "1988-01");
  let eIdx = data.months.findIndex(m => m > "2019-12");
  if (eIdx === -1) eIdx = data.months.length;
  const maxP = 6;
  const Ysample = data.Y.slice(Math.max(0, sIdx - maxP), eIdx);
  const p = selectLagAIC(Ysample, maxP);
  const v = estimateVAR(Ysample, p, maxP);
  const rho = spectralRadius(v.A);
  if (rho >= 1) throw new Error(`Estimated VAR is not stable (spectral radius ${rho.toFixed(3)})`);

  const { Psi } = structuralMA(v, H);
  const boot = identifiedEffects(v, Ysample, hold, H, reps);
  const effect = boot.med;

  const base = forecastPath(v, data.Y, H);
  const fevar = Array.from({ length: H }, (_, h) => {
    const row = new Array(v.n).fill(0);
    for (let j = 0; j <= h; j++) for (let i = 0; i < v.n; i++) for (let m = 0; m < v.n; m++) row[i] += Psi[j][i][m] ** 2;
    return row;
  });

  const bridge = gdpBridge(data);
  const fMonths = Array.from({ length: H }, (_, h) => addMonthsYm(data.originMonth, h + 1));
  const histN = 48;
  const hMonths = data.months.slice(-histN);

  // Scenario paths for every candidate move (effects are linear in the move size).
  const varSeries = (move) => {
    const out = {};
    MODEL_VARS.forEach((mv, i) => {
      const mean = [], p10 = [], p90 = [], eff = [], effLo = [], effHi = [];
      for (let h = 0; h < H; h++) {
        const e = move * effect[h][i];
        const sd = Math.sqrt(fevar[h][i] + (move * boot.sd[h][i]) ** 2);
        mean.push(round(base[h][i] + e)); p10.push(round(base[h][i] + e - Z80 * sd)); p90.push(round(base[h][i] + e + Z80 * sd));
        const a = move * boot.q10[h][i], b = move * boot.q90[h][i];
        eff.push(round(e)); effLo.push(round(Math.min(a, b))); effHi.push(round(Math.max(a, b)));
      }
      out[mv.key] = { mean, p10, p90, effect: eff, effectLo: effLo, effectHi: effHi };
    });
    const ip = out.ip;
    out.gdp = {
      mean: ip.mean.map(x => round(bridge.a + bridge.b * x)),
      p10: [], p90: [],
      effect: ip.effect.map(x => round(bridge.b * x)),
      effectLo: ip.effectLo.map((x, h) => round(bridge.b * (bridge.b >= 0 ? x : ip.effectHi[h]))),
      effectHi: ip.effectHi.map((x, h) => round(bridge.b * (bridge.b >= 0 ? x : ip.effectLo[h]))),
    };
    for (let h = 0; h < H; h++) {
      const sdIp = (ip.p90[h] - ip.p10[h]) / (2 * Z80);
      const sd = Math.sqrt((bridge.b * sdIp) ** 2 + bridge.residSd ** 2);
      out.gdp.p10.push(round(out.gdp.mean[h] - Z80 * sd)); out.gdp.p90.push(round(out.gdp.mean[h] + Z80 * sd));
    }
    return out;
  };

  const scenarios = {};
  for (const mv of CANDIDATE_MOVES) scenarios[String(Math.round(mv * 100))] = varSeries(mv);

  const last = data.Y[data.Y.length - 1];
  const yearAgo = data.Y[data.Y.length - 13];
  const model = {
    meta: {
      kind: "VAR(p) OLS, sign-restricted policy shock",
      lags: p, sample: `${data.months[Math.max(0, sIdx - maxP) + maxP]} to ${data.months[eIdx - 1]}`,
      observations: v.T, spectralRadius: round(rho, 4),
      identification: `Sign restrictions (Uhlig 2005) for ${SIGN_MONTHS} months; ${boot.draws} admissible shocks from ${boot.varDrawsWithShock}/${boot.varDraws} bootstrap VAR draws`,
      holdMonths: hold, horizon: H, asOf: asOf || null,
      dataOrigin: data.originMonth,
      interpolated: data.filled,
      gdpBridge: { slope: round(bridge.b), intercept: round(bridge.a), residSd: round(bridge.residSd), quarters: bridge.n },
      dataNote: asOf
        ? "Historical mode: data truncated to what had been published before the as-of date, using today's revised values (not real-time vintages)."
        : "Latest available FRED data.",
      assumptions: MODEL_ASSUMPTIONS,
      variables: [...MODEL_VARS.map(({ key, label, unit, src }) => ({ key, label, unit, src })),
        { key: "gdp", label: "Real GDP growth (bridge)", unit: "% YoY", src: "GDPC1 via IP bridge" }],
    },
    conditions: {
      dataMonth: data.originMonth,
      policyRate: round(data.policyRate),
      effectiveFfr: round(last[FFR]),
      coreInflation: round(last[IDX.infl]), coreInflation12mAgo: round(yearAgo[IDX.infl]),
      unemployment: round(last[IDX.u]), unemployment12mAgo: round(yearAgo[IDX.u]),
      naturalUnemployment: data.nrou != null ? round(data.nrou) : null,
      naturalUnemployment12mAgo: data.nrou12 != null ? round(data.nrou12) : null,
      ipGrowth: round(last[IDX.ip]),
      gdpGrowth: bridge.latest ? round(bridge.latest.v) : null, gdpQuarter: bridge.latest?.q ?? null,
    },
    history: {
      months: hMonths,
      series: Object.fromEntries(MODEL_VARS.map((mv, i) => [mv.key, data.Y.slice(-histN).map(r => round(r[i]))])),
    },
    forecastMonths: fMonths,
    scenarios,
  };
  modelCache.set(cacheKey, { t: Date.now(), model });
  return model;
}

// Effect band for a policy move on a variable at horizon h (months, 1-based).
export function policyEffectAt(model, moveBp, key, h) {
  const idx = Math.max(0, Math.min(model.meta.horizon - 1, h - 1));
  const s25 = model.scenarios["25"][key];
  const k = moveBp / 25; // linear scaling from the +25bp scenario
  const a = k * s25.effectLo[idx], b = k * s25.effectHi[idx];
  return { point: k * s25.effect[idx], lo: Math.min(a, b), hi: Math.max(a, b) };
}

export function baselineChangeAt(model, key, h) {
  const idx = Math.max(0, Math.min(model.meta.horizon - 1, h - 1));
  const s = model.scenarios["0"][key];
  const now = key === "gdp" ? model.conditions.gdpGrowth
    : model.history.series[key][model.history.series[key].length - 1];
  return { point: s.mean[idx] - now, lo: s.p10[idx] - now, hi: s.p90[idx] - now, level: s.mean[idx] };
}

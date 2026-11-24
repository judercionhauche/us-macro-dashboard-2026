// Relay only the Risk Lab's three public entry points to the Python service.
const ROUTES = new Map([
  ["/risk/study", ["GET", "/api/study"]],
  ["/risk/history", ["GET", "/api/current-history"]],
  ["/risk/debate", ["POST", "/api/debate"]],
]);

export function riskCors(env) {
  return {
    "Access-Control-Allow-Origin": env.RISK_PAGE_ORIGIN || "https://judercionhauche.github.io",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Risk-Access",
    "Vary": "Origin",
  };
}

export async function riskRelay(request, env) {
  const url = new URL(request.url);
  const cors = riskCors(env);
  const fail = (error, status) => Response.json({error}, {status, headers:cors});
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
  const route = ROUTES.get(url.pathname);
  if (!route || request.method !== route[0]) return fail("Risk route unavailable.", 404);
  if (!env.RISK_UPSTREAM || !env.RISK_RELAY_SECRET || !env.RISK_VIEWER_KEY) {
    return fail("The live model server is not connected.", 503);
  }
  const paid = request.method === "POST";
  if (paid && request.headers.get("X-Risk-Access") !== env.RISK_VIEWER_KEY) {
    return fail("The live debate requires the shared access code.", 403);
  }
  const endpoint = new URL(route[1], env.RISK_UPSTREAM);
  if (endpoint.protocol !== "https:") return fail("Live model server configuration is invalid.", 503);
  if (route[1] === "/api/current-history") endpoint.searchParams.set("cik", url.searchParams.get("cik") || "");
  let body;
  if (paid) {
    body = await request.text();
    if (new TextEncoder().encode(body).length > 1024) return fail("Request is too large.", 413);
  }
  try {
    const response = await fetch(endpoint, {
      method:request.method, redirect:"manual", body,
      headers:{"Content-Type":"application/json","X-Risk-Relay":env.RISK_RELAY_SECRET},
    });
    if (response.status >= 300 && response.status < 400) return fail("The live model server is unavailable.", 502);
    return new Response(response.body, {
      status:response.status,
      headers:{...cors,"Content-Type":response.headers.get("Content-Type") || "application/json",
               "Cache-Control":"no-store"},
    });
  } catch {
    return fail("The live model server is unavailable.", 502);
  }
}

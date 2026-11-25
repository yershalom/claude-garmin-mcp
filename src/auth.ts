import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { allowedLogin, publicOrigin } from "./env";

// Login for MCP clients (Claude): the OAuth provider sends the user here, we show what is asking
// for access, then sign them in with GitHub and only let ALLOWED_GITHUB_LOGIN through.
// If ALLOWED_GITHUB_LOGIN isn't set, nobody gets through.

const STATE_TTL_S = 600;
const CSRF_COOKIE = "__Host-garmin_mcp_csrf";
const STATE_COOKIE = "__Host-garmin_mcp_state";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge = STATE_TTL_S) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f5f1;--card:#fff;--ink:#1d1f22;--muted:#63676e;--accent:#2f7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1e2125;--ink:#ecedef;--muted:#a2a7ae;--accent:#6cc28f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:14px;padding:24px;max-width:440px;width:100%}
h1{font-size:1.3rem;margin:0 0 8px}p{color:var(--muted)}code{font-size:.9em;word-break:break-all}button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", ...headers },
  });
}

/** The home page lists the exact addresses to paste into GitHub and Claude, and what is still missing. */
function home(request: Request, env: Env): Response {
  const origin = publicOrigin(request, env);
  const missing = ["ALLOWED_GITHUB_LOGIN", "GARMIN_API_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"].filter(
    (name) => !String(env[name as keyof Env] ?? "").trim(),
  );
  const setup = missing.length
    ? `<p><b>Not set up yet.</b> Add these as secrets in Cloudflare (your Worker → Settings → Variables and Secrets):
       ${missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}.</p>`
    : "<p>Set up. Only its owner can sign in.</p>";
  return page(
    "Garmin MCP",
    `<p>Private MCP server.</p>${setup}
     <p>GitHub OAuth app callback URL:<br><code>${esc(origin)}/callback</code></p>
     <p>Claude connector URL:<br><code>${esc(origin)}/mcp</code></p>`,
  );
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  if (!allowedLogin(env)) return page("Not set up", "<p>Set the <code>ALLOWED_GITHUB_LOGIN</code> secret first.</p>", 500);
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return page("Unknown app", "<p>This app isn't registered.</p>", 400);

  const state = randomId();
  const csrf = randomId();
  await env.OAUTH_KV.put(`auth:${state}`, JSON.stringify(authRequest), { expirationTtl: STATE_TTL_S });

  const name = client.clientName || "An MCP client";
  const redirectHost = new URL(authRequest.redirectUri).host;
  return page(
    "Connect to your Garmin data?",
    `<p><b>${esc(name)}</b> wants read-only access to your Garmin Connect data through this server.</p>
     <p>After you approve, you'll be sent back to <b>${esc(redirectHost)}</b>.</p>
     <form method="post" action="/authorize"><input type="hidden" name="state" value="${esc(state)}">
     <input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Sign in with GitHub and approve</button></form>`,
    200,
    { "Set-Cookie": setCookie(CSRF_COOKIE, csrf) },
  );
}

async function approve(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const csrf = String(form.get("csrf") ?? "");
  if (!csrf || csrf !== cookie(request, CSRF_COOKIE)) return page("Request expired", "<p>Start again from Claude.</p>", 400);
  if (!state || !(await env.OAUTH_KV.get(`auth:${state}`))) return page("Request expired", "<p>Start again from Claude.</p>", 400);

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");

  const headers = new Headers({ Location: gh.href });
  headers.append("Set-Cookie", setCookie(STATE_COOKIE, state));
  headers.append("Set-Cookie", setCookie(CSRF_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  // The state must match the browser that started the flow, and can be used only once.
  if (!state || state !== cookie(request, STATE_COOKIE)) return page("Sign-in failed", "<p>Start again from Claude.</p>", 400);
  const stored = await env.OAUTH_KV.get(`auth:${state}`);
  await env.OAUTH_KV.delete(`auth:${state}`);
  if (!stored || !code) return page("Sign-in failed", "<p>The request expired. Start again from Claude.</p>", 400);
  const authRequest = JSON.parse(stored) as AuthRequest;

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).href,
    }),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenJson.access_token) return page("Sign-in failed", "<p>GitHub didn't return a token.</p>", 502);

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "garmin-mcp" },
  });
  const user = (await userRes.json().catch(() => ({}))) as { login?: string };
  if (!user.login || user.login.toLowerCase() !== allowedLogin(env)) {
    return page("Not allowed", "<p>This server only accepts its owner's GitHub account.</p>", 403);
  }

  const props: Props = { login: user.login };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.login.toLowerCase(),
    metadata: { label: user.login },
    scope: authRequest.scope,
    props,
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo, "Set-Cookie": setCookie(STATE_COOKIE, "", 0) } });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (pathname === "/authorize" && request.method === "POST") return await approve(request, env);
      if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
      if (pathname === "/") return home(request, env);
    } catch (err) {
      console.error("auth error", err);
      return page("Something went wrong", "<p>Start again from Claude.</p>", 400);
    }
    return new Response("Not found", { status: 404 });
  },
};

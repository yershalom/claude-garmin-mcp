import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** The only GitHub account allowed to sign in. Set as a secret, like the three below. */
  ALLOWED_GITHUB_LOGIN?: string;
  /** Optional. Only needed to pin one address when the Worker answers on several. */
  PUBLIC_URL?: string;
  GARMIN_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/** What the OAuth provider stores in each grant and hands to the MCP handler. */
export interface Props extends Record<string, unknown> {
  login: string;
}

/** The Worker's public address: PUBLIC_URL if set, otherwise the address this request came in on. */
export function publicOrigin(request: Request, env: Env): string {
  return new URL(env.PUBLIC_URL || request.url).origin;
}

/** The allowed GitHub login, lowercased, or undefined if it isn't set (then nobody gets in). */
export function allowedLogin(env: Env): string | undefined {
  const login = env.ALLOWED_GITHUB_LOGIN?.trim().replace(/^@/, "").toLowerCase();
  return login || undefined;
}

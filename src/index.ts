import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth";
import type { Env } from "./env";
import { publicOrigin } from "./env";
import { mcpHandler } from "./mcp";

// The provider advertises the Worker's own address in its OAuth metadata. That address is the one
// the request came in on (or PUBLIC_URL, if set), so one provider is built per address and reused.
// A Worker only receives requests for its own routes, so this is a short, fixed list.
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    // /mcp requires a valid OAuth access token; everything else (login pages, OAuth endpoints) is public.
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: authHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      accessTokenTTL: 60 * 60,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "Garmin MCP",
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(publicOrigin(request, env)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { APP_NAMES, type AppScheme, renderHandoff } from "@ponzu/core/handoff";
import {
  consumeAgentCode,
  createAgentAuthorization,
  getAgentClient,
  getAgentCode,
  issueAgentTokens,
  registerAgentClient,
  revokeAgentToken,
  useAgentRefreshToken,
  verifyAgentToken,
} from "@ponzu/db";
import type { Context } from "hono";
import type { Deps } from "../deps/index.ts";

/*
 * Ponzu as the OAuth authorization server for a person's own agent (docs/cloud.md, "Your own
 * agent"), in the shape the MCP's authorization spec asks for: dynamic client registration,
 * the authorization code flow with PKCE (S256), refresh tokens, revocation, and the metadata
 * documents that let an agent find all of it from a 401 on the MCP.
 *
 * The endpoints are the MCP SDK's own handlers (through @hono/mcp, `routes/oauth.ts`); this is
 * the provider they call. Why Ponzu and not WorkOS: the API honours a WorkOS token only for a
 * session its own sign-in exchange recorded, which checks GitHub, and AuthKit's MCP flow would
 * mint tokens for sessions that never went through it. So the person allows an agent in the
 * signed-in Ponzu app instead: the authorize endpoint answers a handoff page that opens the
 * app (`<scheme>://agents/connect?request=<id>`), the app asks the person, and the API gives
 * the app the agent's redirect with its code, which the app opens in the browser.
 */

/** The MCP, relative to the API's origin. */
export const MCP_PATH = "/v1/mcp";
/** Where the OAuth endpoints are, relative to the API's origin. */
export const OAUTH_PATH = "/v1/oauth";

/** The API's own origin, as the request reached it: the issuer and the MCP's resource. */
export function apiOrigin(c: Context): string {
  return new URL(c.req.url).origin;
}

/** Which of the apps a link from this environment opens: the release's in production. */
export function appScheme(deps: Pick<Deps, "config">): AppScheme {
  return deps.config.build.environment === "production" ? "ponzu" : "ponzu-dev";
}

/** RFC 8414's document for this authorization server. */
export function authorizationServerMetadata(origin: string): OAuthMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATH}/authorize`,
    token_endpoint: `${origin}${OAUTH_PATH}/token`,
    registration_endpoint: `${origin}${OAUTH_PATH}/register`,
    revocation_endpoint: `${origin}${OAUTH_PATH}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation: "https://ponzu.design/docs/agents",
  };
}

/** RFC 9728's document for the MCP. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    resource_name: "Ponzu",
    bearer_methods_supported: ["header"],
  };
}

/**
 * Agents as the registration endpoint records them. Only public clients: whatever an agent asks
 * for, Ponzu issues no client secret (an agent on a person's computer can't keep one, and PKCE
 * is what holds the code to whoever asked for it), so none is stored either.
 */
function clientsStore(deps: Pick<Deps, "db">): OAuthRegisteredClientsStore {
  return {
    async getClient(clientId) {
      const client = await getAgentClient(deps.db, clientId);
      return client ? toClientInformation(client) : undefined;
    },
    async registerClient(asked) {
      const {
        client_secret: _secret,
        client_secret_expires_at: _expires,
        ...metadata
      } = asked as OAuthClientInformationFull;
      const client = await registerAgentClient(deps.db, {
        name: clean(metadata.client_name),
        redirectUris: metadata.redirect_uris.map(String),
        metadata: { ...metadata, token_endpoint_auth_method: "none" },
      });
      return toClientInformation(client);
    },
  };
}

function toClientInformation(client: {
  id: string;
  createdAt: Date;
  redirectUris: string[];
  metadata: Record<string, unknown>;
}): OAuthClientInformationFull {
  return {
    ...(client.metadata as Omit<OAuthClientInformationFull, "client_id" | "redirect_uris">),
    redirect_uris: client.redirectUris,
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    token_endpoint_auth_method: "none",
  };
}

/** A name an agent gave itself, as Ponzu will show it: one line, at most 60 characters. */
export function clean(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const line = name
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line ? line.slice(0, 60) : null;
}

function tokens({
  accessToken,
  refreshToken,
  expiresIn,
}: Awaited<ReturnType<typeof issueAgentTokens>>): OAuthTokens {
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
  };
}

/** The provider the SDK's handlers call, for one request. */
export function oauthProvider(deps: Pick<Deps, "db" | "config">): OAuthServerProvider {
  return {
    get clientsStore() {
      return clientsStore(deps);
    },

    /**
     * Record the ask and answer the page that hands it to the app. @hono/mcp passes the
     * request's context where the SDK's types say Express's response; the answer is set on it.
     */
    async authorize(client, params: AuthorizationParams, res) {
      const c = res as unknown as Context;
      const id = await createAgentAuthorization(deps.db, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        scope: params.scopes?.join(" ") || null,
        resource: params.resource?.href ?? null,
      });
      const scheme = appScheme(deps);
      const { html, csp } = await consentHandoff(scheme, id, clean(client.client_name));
      c.res = new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },

    async challengeForAuthorizationCode(client, code) {
      const found = await getAgentCode(deps.db, code);
      if (!found || found.clientId !== client.client_id) {
        throw new InvalidGrantError("The code is not valid.");
      }
      return found.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const found = await getAgentCode(deps.db, code);
      if (redirectUri !== undefined && found && found.redirectUri !== redirectUri) {
        throw new InvalidGrantError("redirect_uri is not the one the code was issued for.");
      }
      const grantId = await consumeAgentCode(deps.db, { code, clientId: client.client_id });
      if (!grantId) throw new InvalidGrantError("The code is not valid, or was used already.");
      return tokens(await issueAgentTokens(deps.db, grantId));
    },

    async exchangeRefreshToken(client, refreshToken) {
      const grantId = await useAgentRefreshToken(deps.db, {
        refreshToken,
        clientId: client.client_id,
      });
      if (!grantId) throw new InvalidGrantError("The refresh token is not valid.");
      return tokens(await issueAgentTokens(deps.db, grantId));
    },

    async verifyAccessToken(token) {
      const found = await verifyAgentToken(deps.db, token);
      if (!found) throw new InvalidTokenError("The token is not valid.");
      return { token, clientId: found.grant.clientId, scopes: [] };
    },

    async revokeToken(client, { token }) {
      await revokeAgentToken(deps.db, { token, clientId: client.client_id });
    },
  };
}

/** The page the agent's authorize request lands on: it opens the app to ask the person. */
export function consentHandoff(scheme: AppScheme, requestId: string, clientName: string | null) {
  const app = APP_NAMES[scheme];
  const who = clientName ?? "An agent";
  const title = `Connect ${clientName ?? "your agent"} to Ponzu`;
  const link = new URL(`${scheme}://agents/connect`);
  link.searchParams.set("request", requestId);
  return renderHandoff({
    documentTitle: title,
    problem: false,
    view: { title, body: `Opening ${app}…` },
    link: {
      href: link.toString(),
      app,
      opened: { title, body: `${who} is waiting for you in ${app}. Allow it there.` },
      missed: {
        title,
        body: `Open ${app} and sign in to allow ${who}. You have 15 minutes.`,
      },
    },
  });
}

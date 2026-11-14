import {
  authenticateClient,
  authorizeHandler,
  clientRegistrationHandler,
  revokeHandler,
  tokenHandler,
} from "@hono/mcp/auth";
import { type Context, Hono, type Next } from "hono";
import {
  apiOrigin,
  authorizationServerMetadata,
  oauthProvider,
  protectedResourceMetadata,
} from "../agents/oauth.ts";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";

/*
 * The OAuth endpoints a person's own agent signs in through (agents/oauth.ts). Each is public:
 * the agent has no Ponzu token yet, and what it holds (a code, a refresh token) is checked by the
 * handler. The handlers are the MCP SDK's, as @hono/mcp ports them, and answer OAuth's own error
 * bodies rather than the API's, since that is what agents read.
 */

type Handler = (c: Context, next: Next) => Promise<Response | void>;

/** A handler made for this request's deps, since the provider reads the database. */
function perRequest(make: (c: Context<AppEnv>) => Handler) {
  return (c: Context<AppEnv>, next: Next) => make(c)(c as unknown as Context, next);
}

/** A handler for the token and revocation endpoints: the client is named first. */
function withClient(make: (c: Context<AppEnv>) => Handler) {
  return perRequest((c) => async (raw, next) => {
    const provider = oauthProvider(c.var.deps);
    let reached = false;
    const answered = await authenticateClient({ clientsStore: provider.clientsStore })(
      raw,
      async () => {
        reached = true;
      },
    );
    if (!reached) return answered ?? raw.res;
    return make(c)(raw, next);
  });
}

export const oauth = new Hono<AppEnv>()
  .post(
    "/register",
    access.public,
    perRequest((c) =>
      clientRegistrationHandler({ clientsStore: oauthProvider(c.var.deps).clientsStore }),
    ),
  )
  .get(
    "/authorize",
    access.public,
    perRequest((c) => authorizeHandler(oauthProvider(c.var.deps))),
  )
  .post(
    "/token",
    access.public,
    withClient((c) => tokenHandler(oauthProvider(c.var.deps))),
  )
  .post(
    "/revoke",
    access.public,
    withClient((c) => revokeHandler(oauthProvider(c.var.deps))),
  );

/**
 * The two discovery documents, at the API's root as their RFCs place them: the MCP's (RFC 9728),
 * which a 401 from it names, and the authorization server's (RFC 8414).
 */
export const wellKnown = new Hono<AppEnv>()
  .get("/oauth-protected-resource/v1/mcp", access.public, (c) =>
    c.json(protectedResourceMetadata(apiOrigin(c))),
  )
  .get("/oauth-protected-resource", access.public, (c) =>
    c.json(protectedResourceMetadata(apiOrigin(c))),
  )
  .get("/oauth-authorization-server", access.public, (c) =>
    c.json(authorizationServerMetadata(apiOrigin(c))),
  );

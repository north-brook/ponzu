import { getUserByWorkosId, verifyRunnerToken } from "@ponzu/db";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { verifyAccessToken } from "./access-token.ts";
import type { RunnerActor, UserActor } from "./actor.ts";

/*
 * Who may call a route. Every route names one of these as its first handler:
 *
 *   .get("/", access.user, (c) => …)
 *
 * or a whole area does, with `.use(access.user)` before its routes. A route that names none
 * is refused before its handler runs (`denyUndeclared`), so forgetting is a failing test and
 * not an open door.
 */

type Declaration<Actor> = MiddlewareHandler<AppEnv & { Variables: { actor: Actor } }>;

const declarations = new WeakSet<object>();

function declare<Handler extends MiddlewareHandler<any>>(handler: Handler): Handler {
  declarations.add(handler);
  return handler;
}

const RUNNER_TOKEN_PREFIX = "pzr_";

/** The bearer token, or a 401 that says there is none. */
function bearer(c: Context): string {
  const [scheme, token, ...rest] = (c.req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
    throw new ApiError(401, "unauthenticated", "Sign in to do this.");
  }
  return token;
}

export const access = {
  /** Anyone, signed in or not. */
  public: declare<MiddlewareHandler<AppEnv>>((_c, next) => next()),

  /**
   * A signed-in person: a WorkOS access token as the bearer, verified here, whose user has a
   * row. The handler reads them from `c.var.actor`.
   */
  user: declare<Declaration<UserActor>>(async (c, next) => {
    const { db, workos, clock } = c.var.deps;
    const claims = await verifyAccessToken(bearer(c), { workos, clock });
    const user = await getUserByWorkosId(db, claims.workosUserId);
    if (!user) {
      throw new ApiError(401, "user_not_found", "Sign in again to finish setting up your account.");
    }
    c.set("actor", { kind: "user", user, sessionId: claims.sessionId });
    return next();
  }),

  /**
   * The runner inside a design's sandbox: a runner token as the bearer. The handler reads the
   * one design it may act on from `c.var.actor.designId`, and must not act on any other.
   */
  runner: declare<Declaration<RunnerActor>>(async (c, next) => {
    const token = bearer(c);
    const found = token.startsWith(RUNNER_TOKEN_PREFIX)
      ? await verifyRunnerToken(c.var.deps.db, token)
      : null;
    if (!found) throw new ApiError(401, "token_invalid", "This runner token is not valid.");
    c.set("actor", { kind: "runner", tokenId: found.id, designId: found.designId });
    return next();
  }),
};

/**
 * Refuses a request unless the first thing its route runs is an access declaration, so
 * nothing of the route's (not even its validation) happens for a caller it has not admitted.
 * `infrastructure` is the app's own middleware, which every request matches; a request that
 * matches nothing else has no route, and goes on to be a 404.
 */
export function denyUndeclared(infrastructure: readonly unknown[]): MiddlewareHandler<AppEnv> {
  const guard: MiddlewareHandler<AppEnv> = (c, next) => {
    const handlers = matchedRoutes(c)
      .map((route) => route.handler)
      .filter((handler) => handler !== guard && !infrastructure.includes(handler));
    if (handlers.length > 0 && !declarations.has(handlers[0]!)) {
      throw new ApiError(403, "access_undeclared", "This route does not say who may call it.");
    }
    return next();
  };
  return guard;
}

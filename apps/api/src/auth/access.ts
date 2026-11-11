import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { RouterRoute } from "hono/types";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import type { Actor, LeasedRunner, RunnerActor, UserActor } from "./actor.ts";
import { authenticateRunner, authenticateUser, isRunnerToken } from "./authenticate.ts";

/*
 * Who may call a route. Every route names one of these as its first handler:
 *
 *   .get("/", access.user, (c) => …)
 *
 * An area whose routes are all for signed-in people (or all for runners) may say so once,
 * with `.use(access.user)` before them. `access.public` is always written on the route
 * itself: opening a route to anyone is decided one route at a time. A route that names none
 * is refused before its handler runs (`denyUndeclared`), so forgetting is a failing test and
 * not an open door.
 */

type Declaration<A extends Actor> = MiddlewareHandler<AppEnv & { Variables: { actor: A } }>;

/** Each declaration, and whether it lets a caller through without knowing who they are. */
const declarations = new WeakMap<object, "open" | "authenticated">();

function declare<Handler extends MiddlewareHandler<any>>(
  kind: "open" | "authenticated",
  handler: Handler,
): Handler {
  declarations.set(handler, kind);
  return handler;
}

/** The bearer token, or a 401 that says there is none. */
function bearer(c: Context): string {
  const [scheme, token, ...rest] = (c.req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
    throw new ApiError(401, "unauthenticated", "Sign in to do this.");
  }
  return token;
}

export const access = {
  /** Anyone, signed in or not. Only ever on the route itself, never on an area with `.use`. */
  public: declare<MiddlewareHandler<AppEnv>>("open", (_c, next) => next()),

  /**
   * A signed-in person: a WorkOS access token as the bearer, for a session the sign-in
   * exchange admitted (`authenticateUser`). The handler reads the person from `c.var.actor`.
   * This says who is asking, not what they may touch: see `auth/authorize.ts`.
   */
  user: declare<Declaration<UserActor>>("authenticated", async (c, next) => {
    c.set("actor", await authenticateUser(c.var.deps, bearer(c)));
    return next();
  }),

  /**
   * The runner inside a design's sandbox: a runner token as the bearer, and the design's lease
   * as `X-Ponzu-Runner` (409 `superseded` without it). The handler reads the one design it may
   * act on from `c.var.actor.designId`, and must not act on any other.
   */
  runner: declare<Declaration<LeasedRunner>>("authenticated", async (c, next) => {
    c.set("actor", await authenticateRunner(c.var.deps, bearer(c), c.req.header(RUNNER_HEADER)));
    return next();
  }),

  /** A runner starting, on the one route that takes the lease: no `X-Ponzu-Runner` yet. */
  runnerStarting: declare<Declaration<RunnerActor>>("authenticated", async (c, next) => {
    c.set("actor", await authenticateRunner(c.var.deps, bearer(c), "taking"));
    return next();
  }),

  /**
   * Either a person or a runner that holds its lease, for a route both call (a design's ops are
   * posted by people and by its runner). The handler tells them apart by `c.var.actor.kind`.
   */
  userOrRunner: declare<Declaration<Actor>>("authenticated", async (c, next) => {
    const token = bearer(c);
    const { deps } = c.var;
    c.set(
      "actor",
      isRunnerToken(token)
        ? await authenticateRunner(deps, token, c.req.header(RUNNER_HEADER))
        : await authenticateUser(deps, token),
    );
    return next();
  }),
};

/**
 * The first of a request's handlers that would run for a caller no declaration has admitted,
 * or undefined when every one of them is covered. `routes` is what the request matched, in
 * the order it will run, without the app's own middleware.
 *
 * A handler is covered when a declaration that authenticates (`user`, `runner`,
 * `userOrRunner`) comes before it, wherever that was registered: it has run by then and
 * demanded a token. `access.public` covers only handlers registered for its own method and
 * path. It lets everyone through, so one written on an area, or on another route that
 * happens to match, must not open a route whose author never said it was public.
 */
export function firstUndeclared(routes: readonly RouterRoute[]): RouterRoute | undefined {
  let authenticated = false;
  const open = new Set<string>();
  const key = (route: RouterRoute) => `${route.method} ${route.path}`;
  for (const route of routes) {
    const kind = declarations.get(route.handler);
    if (kind === "authenticated") authenticated = true;
    // `ALL` is what `.use` registers under, and no way to tell it from `.all`.
    else if (kind === "open" && route.method !== "ALL") open.add(key(route));
    else if (!kind && !authenticated && !open.has(key(route))) return route;
  }
  return undefined;
}

/**
 * Refuses a request unless every handler it would reach is covered by an access declaration
 * (`firstUndeclared`), so nothing of a route's (not even its validation) happens for a caller
 * it has not admitted. `infrastructure` is the app's own middleware, which every request
 * matches; a request that matches nothing else has no route, and goes on to be a 404.
 */
export function denyUndeclared(infrastructure: readonly unknown[]): MiddlewareHandler<AppEnv> {
  const guard: MiddlewareHandler<AppEnv> = (c, next) => {
    const routes = matchedRoutes(c).filter(
      (route) => route.handler !== guard && !infrastructure.includes(route.handler),
    );
    if (firstUndeclared(routes)) {
      throw new ApiError(403, "access_undeclared", "This route does not say who may call it.");
    }
    return next();
  };
  return guard;
}

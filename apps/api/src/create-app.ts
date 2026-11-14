import { type Context, Hono, type MiddlewareHandler } from "hono";
import { analyticsScope } from "./analytics/middleware.ts";
import { denyUndeclared } from "./auth/access.ts";
import type { Deps } from "./deps/index.ts";
import { clientVersionGate } from "./http/client-version.ts";
import type { AppEnv } from "./http/context.ts";
import { cors } from "./http/cors.ts";
import { ApiError, toApiError } from "./http/errors.ts";
import { readOnlyGate } from "./http/maintenance.ts";
import { requestContext } from "./http/request.ts";
import { v1 } from "./routes/index.ts";
import { wellKnown } from "./routes/oauth.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * The whole API as one Hono app, on whatever `deps` it is given: the real ones in a
 * deployment, fakes under test.
 *
 * Order matters. Every request gets its id and log line first, then its analytics scope (who
 * and what a capture during it is about: `analytics/scope.ts`), then CORS (which answers a
 * preflight by itself), then the client-version gate, then the maintenance switch's read-only
 * gate (`http/maintenance.ts`), then the check that the route says who may call it. Errors are turned into the one error body here and nowhere else: no sub-app
 * sets its own `onError`.
 */
export function createApp(deps: Deps) {
  // The MCP calls the app itself, as the person (mcp/internal.ts).
  const self: MiddlewareHandler<AppEnv> = (c, next) => {
    c.set("self", (request) => app.fetch(request));
    return next();
  };
  const infrastructure = [
    requestContext(deps),
    self,
    analyticsScope,
    cors,
    clientVersionGate(deps.config.minimumClientVersions),
    readOnlyGate,
  ];
  const app = new Hono<AppEnv>();
  for (const middleware of infrastructure) app.use(middleware);
  app.use(denyUndeclared(infrastructure));
  app.route("/.well-known", wellKnown);
  const routed = app.route("/v1", v1);

  app.notFound((c) => {
    // A path that exists under another method is a 405 that names the methods it does take.
    const allowed = METHODS.filter((method) =>
      app.router.match(method, c.req.path)[0].some(([[, route]]) => route.method === method),
    );
    if (allowed.length === 0) {
      return respond(c, new ApiError(404, "not_found", "There is nothing at this address."));
    }
    c.header("allow", allowed.join(", "));
    return respond(
      c,
      new ApiError(405, "method_not_allowed", "This address does not take that method."),
    );
  });

  app.onError((thrown, c) => {
    const error = toApiError(thrown);
    const fields = { status: error.status, errorCode: error.code, error: error.cause };
    // A refusal (validation, not found, signed out) is the API working, and so is the 503 of
    // the maintenance switch, which someone turned on; any other 5xx is not.
    if (error.status >= 500 && error.code !== "maintenance") {
      c.var.log.error("request_failed", fields);
      c.var.deps.analytics.exception(error.cause ?? thrown, {
        status: error.status,
        error_code: error.code,
      });
    } else c.var.log.warn("request_refused", fields);
    return respond(c, error);
  });

  return routed;
}

function respond(c: Context<AppEnv>, error: ApiError) {
  return c.json(error.body, error.status);
}

/** The app's routes as a type, for the typed client: `hc<AppType>(url)`. */
export type AppType = ReturnType<typeof createApp>;

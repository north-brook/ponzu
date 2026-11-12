import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "../http/context.ts";
import { withScope } from "./scope.ts";

/**
 * What posthog-js's `tracing_headers` adds to the app's requests to the API. The session id is
 * read; the distinct id never is: who a request is about is who it authenticated as.
 */
export const SESSION_HEADER = "x-posthog-session-id";
export const DISTINCT_ID_HEADER = "x-posthog-distinct-id";

/** A PostHog session id is a UUID (v7); anything else a caller put there is not kept. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs the rest of the request inside its analytics scope (`scope.ts`): the person and canvas
 * as the route's access declaration finds them, the app's PostHog session, the request's id,
 * and the route as declared. Whatever captures during the request, or in work it starts, says
 * only what happened.
 */
export const analyticsScope: MiddlewareHandler<AppEnv> = (c, next) => {
  const given = c.req.header(SESSION_HEADER);
  return withScope(
    {
      userId: () => {
        const actor = c.get("actor");
        return actor?.kind === "user" ? actor.user.id : null;
      },
      canvasId: () => {
        const actor = c.get("actor");
        return actor?.kind === "runner" ? actor.canvasId : null;
      },
      sessionId: given && SESSION_ID.test(given) ? given.toLowerCase() : null,
      requestId: c.var.requestId,
      route: () => `${c.req.method} ${routePath(c, -1)}`,
      workspaceId: null,
    },
    next,
  );
};

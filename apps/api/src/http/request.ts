import type { MiddlewareHandler } from "hono";
import type { Deps } from "../deps/index.ts";
import { CLIENT_HEADER } from "./client-version.ts";
import type { AppEnv } from "./context.ts";

export const REQUEST_ID_HEADER = "x-request-id";

/** An id a caller may choose for itself: short, and nothing that could break a log line. */
const CALLER_ID = /^[\w-]{8,64}$/;
const CLIENT_NAME = /^[a-z]+\/[\w.+-]{1,40}$/;

/**
 * The first middleware of every request. It puts the dependencies, a request id and a logger
 * on the context, answers with the id in `x-request-id` and `cache-control: no-store`, and
 * writes the one line that says what the request was and how it ended. The line has the path
 * but never the query string, a header or a body.
 */
export function requestContext(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const given = c.req.header(REQUEST_ID_HEADER);
    const requestId = given && CALLER_ID.test(given) ? given : deps.ids.requestId();
    const started = deps.clock.now();
    c.set("deps", deps);
    c.set("requestId", requestId);
    c.set("log", deps.log.with({ requestId }));

    await next();

    c.res.headers.set(REQUEST_ID_HEADER, requestId);
    // Answers are one person's and some carry tokens: nothing between here and them keeps a
    // copy. A route that really is cacheable says so itself.
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
    const actor = c.get("actor");
    const client = c.req.header(CLIENT_HEADER);
    c.var.log.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: deps.clock.now() - started,
      ...(actor?.kind === "user" ? { userId: actor.user.id } : {}),
      ...(actor?.kind === "runner" ? { canvasId: actor.canvasId } : {}),
      // Only when it is the short thing it should be: a header is the caller's to fill.
      ...(client && CLIENT_NAME.test(client) ? { client } : {}),
    });
  };
}

/**
 * The caller's address as Vercel reports it. Vercel writes these headers itself and drops
 * whatever the caller sent, so they can be believed there; locally they are simply absent.
 */
export function clientIp(headers: Headers): string | undefined {
  return (
    headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined
  );
}

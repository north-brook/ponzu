import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { Actor } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError, type ErrorCode, toApiError, UpstreamError } from "../http/errors.ts";
import type { Logger } from "../http/log.ts";
import { validate } from "../http/validate.ts";
import { LIVE_QUERIES, type LiveQueryDefinition } from "../live/queries.ts";

/** The most queries one call seals. A client renews all of its subscriptions in one call. */
const MAX_QUERIES = 32;

const LiveBody = z.object({
  queries: z
    .array(z.object({ name: z.string().max(64), args: z.unknown().optional() }))
    .min(1)
    .max(MAX_QUERIES),
});

const LiveView = z.object({
  /** Where to subscribe: `createRealtimeClient({ url })`. */
  url: z.string(),
  /** One per query asked for, in the same order. */
  results: z.array(
    z.union([
      z.object({
        name: z.string(),
        /** What `client.subscribe` takes, good for 60 seconds. Ask again to renew it. */
        sealed: z.object({
          capability: z.string(),
          queryFingerprint: z.string(),
          expiresAt: z.number(),
        }),
      }),
      z.object({
        name: z.string(),
        /** Why this one is not sealed: the code and message the matching route would answer. */
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ]),
  ),
});

type LiveContext = { var: { deps: Deps; actor: Actor; log: Logger } };

/** One query sealed, or the refusal a route would have answered with. */
async function seal(c: LiveContext, { name, args }: { name: string; args?: unknown }) {
  const query: LiveQueryDefinition | undefined = Object.hasOwn(LIVE_QUERIES, name)
    ? LIVE_QUERIES[name as keyof typeof LIVE_QUERIES]
    : undefined;
  const refused = (code: ErrorCode, message: string) => ({ name, error: { code, message } });
  if (!query) return refused("not_found", "There is no live query by that name.");
  const parsed = query.args.safeParse(args ?? {});
  if (!parsed.success) {
    return refused("invalid_request", "The arguments are not what this live query takes.");
  }
  try {
    const params = await query.authorize(c, parsed.data);
    return { name, sealed: await c.var.deps.realtime.seal({ sql: query.sql, params }) };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return refused(error.code, error.message);
    // GitHub failing for one repo must not stop every other subscription from renewing.
    if (error instanceof UpstreamError) {
      c.var.log.warn("live_query_upstream_failed", { query: name, service: error.service });
      const { code, message } = toApiError(error);
      return refused(code, message);
    }
    throw error;
  }
}

/**
 * Seals named live queries for Neon Realtime (docs/cloud.md, "Realtime"). Clients never send
 * SQL: they name queries from the registry, each is authorized on its own, and one that is
 * refused does not stop the rest.
 */
export const live = new Hono<AppEnv>().post(
  "/",
  access.userOrRunner,
  validate("json", LiveBody),
  async (c) => {
    const results = await Promise.all(c.req.valid("json").queries.map((query) => seal(c, query)));
    return c.json(LiveView.parse({ url: c.var.deps.realtime.url, results }));
  },
);

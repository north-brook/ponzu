import type { Context } from "hono";
import { routePath } from "hono/route";
import type { Actor } from "../auth/actor.ts";
import type { AppEnv } from "./context.ts";
import { ApiError } from "./errors.ts";

/*
 * Which request counts against which per-caller rate limit, and by whose key (docs/cloud.md,
 * "Security"). The check itself is `deps.rateLimit` (deps/rate-limit.ts), which is off unless
 * PONZU_RATE_LIMITS is `vercel` on Vercel, and fails open.
 *
 * Every authenticated access declaration (auth/access.ts) calls `limitCaller` once it knows who
 * is asking, so a limited request is refused before its validation or handler runs, and a route
 * cannot forget to be counted. A public route (the sign-in exchange, webhooks, health, cron) is
 * never counted here: the firewall's per-address rules cover those.
 */

/** The rate limits, by the id their firewall rule names in its `@vercel/firewall` condition. */
export const RATE_LIMIT_IDS = [
  "user-writes",
  "canvas-creates",
  "messages",
  "uploads",
  "live",
  "github-sync",
  "runner",
  "runner-git",
] as const;

export type RateLimitId = (typeof RATE_LIMIT_IDS)[number];

export interface RateLimitRule {
  /** Whose id the count is kept under: the person's (`usr_…`) or the runner's canvas (`cnv_…`). */
  key: "user" | "canvas";
  /**
   * What the firewall rule for this id says, and the fake counts to. The firewall's rule is
   * what holds in a deployment (infra/vercel-firewall.json); a test pairs the two.
   */
  limit: number;
  windowSeconds: number;
  /** The routes it covers, as `METHOD /v1/path` with Hono's `:param` names. */
  routes: readonly string[];
}

/**
 * Production's table (docs/production.md, program §5.9). `user-writes` and `runner` are the
 * catch-alls: every POST, PATCH or DELETE by a person, and every call by a runner, that no
 * narrower id names. The narrower ids are the only ones such a request counts against.
 *
 * `runner-models` is not here: `/v1/runner/models` is throttled by the runner protocol (one
 * report per ten minutes per lease), not by the firewall.
 */
export const RATE_LIMITS: Record<RateLimitId, RateLimitRule> = {
  "user-writes": { key: "user", limit: 300, windowSeconds: 60, routes: [] },
  "canvas-creates": {
    key: "user",
    limit: 30,
    windowSeconds: 3_600,
    routes: ["POST /v1/canvases"],
  },
  messages: {
    key: "user",
    limit: 60,
    windowSeconds: 60,
    routes: [
      "POST /v1/canvases/:id/messages",
      "POST /v1/canvases/:id/questions/:questionId/answer",
    ],
  },
  uploads: {
    key: "user",
    limit: 120,
    windowSeconds: 3_600,
    routes: ["POST /v1/canvases/:id/uploads", "POST /v1/canvases/:id/comments/:messageId/picture"],
  },
  live: { key: "user", limit: 120, windowSeconds: 60, routes: ["POST /v1/live"] },
  "github-sync": {
    key: "user",
    limit: 30,
    windowSeconds: 3_600,
    routes: ["POST /v1/github/sync", "POST /v1/github/install-link"],
  },
  runner: { key: "canvas", limit: 3_000, windowSeconds: 60, routes: [] },
  "runner-git": {
    key: "canvas",
    limit: 240,
    windowSeconds: 3_600,
    routes: ["POST /v1/runner/git-credential", "POST /v1/runner/git-credential/erase"],
  },
};

/** How long a limited caller is told to wait, in seconds. */
export const RETRY_AFTER_SECONDS = 60;

const BY_ROUTE = new Map<string, RateLimitId>(
  RATE_LIMIT_IDS.flatMap((id) => RATE_LIMITS[id].routes.map((route) => [route, id] as const)),
);

/** The methods a person's request is counted for. A read is never counted here. */
const WRITES = new Set(["POST", "PATCH", "DELETE"]);

/**
 * The rate limit a request counts against, and its key, or null when it counts against none.
 * `route` is `METHOD /v1/path` as the route was declared.
 */
export function rateLimitFor(route: string, actor: Actor): { id: RateLimitId; key: string } | null {
  const named = BY_ROUTE.get(route);
  if (actor.kind === "runner") {
    const id = named && RATE_LIMITS[named].key === "canvas" ? named : "runner";
    return { id, key: actor.canvasId };
  }
  if (named && RATE_LIMITS[named].key === "user") return { id: named, key: actor.user.id };
  const method = route.slice(0, route.indexOf(" "));
  return WRITES.has(method) ? { id: "user-writes", key: actor.user.id } : null;
}

/**
 * Counts this request against its rate limit, once the caller is known, and refuses it with 429
 * `rate_limited` and `Retry-After` when it is over. Off, `deps.rateLimit` answers "ok" without
 * asking anyone.
 */
export async function limitCaller<E extends AppEnv>(c: Context<E>, actor: Actor): Promise<void> {
  const route = `${c.req.method} ${routePath(c, -1)}`;
  const limit = rateLimitFor(route, actor);
  if (!limit) return;
  if ((await c.var.deps.rateLimit.check(limit.id, limit.key, c.req.raw)) === "ok") return;
  c.var.log.warn("rate_limited", { limit: limit.id });
  c.header("retry-after", String(RETRY_AFTER_SECONDS));
  throw new ApiError(429, "rate_limited", "Too many requests. Try again in a moment.");
}

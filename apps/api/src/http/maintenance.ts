import type { MiddlewareHandler } from "hono";
import type { Features } from "../features.ts";
import type { AppEnv } from "./context.ts";
import { ApiError } from "./errors.ts";

/*
 * The maintenance switch, `PONZU_MAINTENANCE` (docs/cloud.md, "Security"): a kill switch for an
 * incident, for spend, and for cutover day, read once from the environment (features.ts).
 *
 *   off            everything works (the default)
 *   wakes_paused   no sandbox wakes: the wake gate `maintenance` (sandboxes/gates.ts) answers
 *                  `paused`, and the wake job tries again until the switch is off. Messages are
 *                  kept in the feed and go in then. Everything else works.
 *   read_only      wakes are paused as above, and every write by a person or a runner answers
 *                  503 `maintenance` before anything of its route runs (`readOnlyGate`, below).
 *
 * Read only lets through what keeps people able to look around, and what keeps a sandbox that
 * is awake alive and saved, so that nothing already made is lost on the way:
 *
 *   - every GET and HEAD (an OPTIONS preflight is answered by CORS before this);
 *   - health and the cron, which run the sweep and the job retries;
 *   - signing in and out (`/v1/auth/*`), and `POST /v1/live`, which is a read;
 *   - a person's presence on a canvas, which says only who is looking;
 *   - GitHub's webhook, which GitHub does not send again;
 *   - of a runner's calls, its start, its heartbeat (`PUT /v1/runner/state`, without which the
 *     sweep would take it as dead), its checkpoints and their upload addresses, its restore,
 *     and git credentials (a fetch is a read). The rest of what a runner sends (its thread,
 *     questions, claim of new events, acks, usage and model reports, canvas edits, pull
 *     request) is refused with a 5xx, which the runner sends again, unchanged, for as long as
 *     it lives (docs/cloud.md, "Rules for every call"), so it goes in once the switch is off.
 *
 * So before read only, pause wakes and let the turns that run finish: a sandbox put to sleep
 * while read only holds back its runner's writes cannot hand them over on its way out.
 */

/** The 503 `maintenance` message, word for word from the production design (§1.5). */
export const MAINTENANCE_MESSAGE = "Ponzu is updating. Try again in a few minutes.";

/** What a write answers while Ponzu is read-only. */
export function maintenanceRefusal(): ApiError {
  return new ApiError(503, "maintenance", MAINTENANCE_MESSAGE);
}

/** Whether wakes are paused: in `wakes_paused`, and in `read_only`, which is more. */
export function wakesPaused(features: Pick<Features, "maintenance">): boolean {
  return features.maintenance !== "off";
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths that pass whatever their method: `/v1/health` itself, and everything under `/v1/cron/`
 * and `/v1/auth/` (a prefix ends in `/`).
 */
const OPEN_PREFIXES = ["/v1/health", "/v1/cron/", "/v1/auth/"];

/** Writes that pass, as `METHOD path`. */
const OPEN_WRITES = new Set([
  "POST /v1/live",
  "POST /v1/github/webhook",
  "POST /v1/runner/session",
  "PUT /v1/runner/state",
  "POST /v1/runner/checkpoint",
  "POST /v1/runner/restore",
  "POST /v1/runner/restored",
  "POST /v1/runner/uploads",
  "POST /v1/runner/git-credential",
  "POST /v1/runner/git-credential/erase",
]);

/** A person's presence on a canvas, set (`PUT`) and taken away (`DELETE`). */
const PRESENCE = /^\/v1\/canvases\/[^/]+\/presence$/;

/** Whether a request goes on while Ponzu is read-only. */
export function passesReadOnly(method: string, path: string): boolean {
  if (READS.has(method)) return true;
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const open = (prefix: string) =>
    prefix.endsWith("/") ? trimmed.startsWith(prefix) : trimmed === prefix;
  if (OPEN_PREFIXES.some(open)) return true;
  if (OPEN_WRITES.has(`${method} ${trimmed}`)) return true;
  return (method === "PUT" || method === "DELETE") && PRESENCE.test(trimmed);
}

/**
 * Refuses every write but those above with 503 `maintenance` while `PONZU_MAINTENANCE` is
 * `read_only`, and is nothing otherwise. The switch is read on each request, from the deps.
 */
export const readOnlyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (
    c.var.deps.features.maintenance === "read_only" &&
    !passesReadOnly(c.req.method, c.req.path)
  ) {
    throw maintenanceRefusal();
  }
  return next();
};

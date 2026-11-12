import type { UserActor } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { maintenanceRefusal } from "./maintenance.ts";

/*
 * What may refuse a person steering a canvas's agent, before anything they sent is written
 * (docs/cloud.md, "The sandbox"). Three routes steer:
 *
 *   POST /v1/canvases (steering only with a first message)   "create"
 *   POST /v1/canvases/:id/messages                           "message"
 *   POST /v1/canvases/:id/questions/:questionId/answer       "answer"
 *
 * Each calls `steer` once it knows the caller may write to the canvas (or create in the
 * workspace) and before it writes. The gates run in this order, and the first that refuses
 * answers the request with its own error; the rest are not asked:
 *
 *   rateLimit     always a pass-through (see below)
 *   maintenance   Ponzu is read-only while it updates: 503 `maintenance`
 *   billing       the workspace is at a billing limit: 402      (filled by W6 B2)
 *
 * A gate refuses by throwing an `ApiError`, and writes nothing. Each lets everything through
 * until its feature fills it.
 *
 * While Ponzu is read-only, `readOnlyGate` (http/maintenance.ts) has already refused these
 * three before their routes ran; `maintenance` here says the same again, so a steer is still
 * refused if that gate's list of what passes ever came to name one.
 *
 * The rate limit (W1 G7) is not asked here: every authenticated request, these three included,
 * is counted once as its caller is authenticated (`auth/access.ts`, `http/rate-limits.ts`),
 * because production's table limits far more routes than these. Its gate stays a pass-through
 * so the order holds; filling it would count each steer twice.
 *
 * `steer` is called from the handler, not mounted as a middleware: a middleware runs before
 * the handler has checked that the caller may touch the canvas, and a refusal such as
 * billing's names the workspace, which must not be shown to someone who cannot see it.
 */

export type SteerAction = "create" | "message" | "answer";

/** What a request gate is asked about. */
export interface SteerRequest {
  action: SteerAction;
  /** The person steering. */
  userId: string;
  /** The workspace of the canvas, or the one it is being created in. */
  workspaceId: string;
  /** Null for a create: there is no canvas yet. */
  canvasId: string | null;
  /**
   * Whether it carries something for the agent. Always, but for a create without a first
   * message, which every gate is still asked about (a rate limit counts every create), and
   * which a gate about the agent's work (billing) lets through.
   */
  withMessage: boolean;
  /** The request itself, for a gate that keys on more than the person (a rate limit). */
  request: Request;
}

export type RequestGate = (deps: Deps, request: SteerRequest) => Promise<void>;

export interface NamedRequestGate {
  name: string;
  gate: RequestGate;
}

const passThrough: RequestGate = async () => {};

/** Nothing new for the agent while Ponzu is read-only (`PONZU_MAINTENANCE=read_only`). */
export const maintenanceSteerGate: RequestGate = async (deps) => {
  if (deps.features.maintenance === "read_only") throw maintenanceRefusal();
};

export const STEER_GATES: readonly NamedRequestGate[] = [
  { name: "rateLimit", gate: passThrough },
  { name: "maintenance", gate: maintenanceSteerGate },
  { name: "billing", gate: passThrough },
];

/** Ask the gates in order; the first that refuses throws, and the rest are not asked. */
export async function askSteerGates(
  deps: Deps,
  request: SteerRequest,
  gates: readonly NamedRequestGate[] = STEER_GATES,
): Promise<void> {
  for (const { gate } of gates) await gate(deps, request);
}

/**
 * The steer gate chain for a person's request: call it once the caller is known to be allowed,
 * and before writing. Throws the first gate's refusal.
 */
export async function steer(
  c: { var: { deps: Deps; actor: UserActor }; req: { raw: Request } },
  {
    action,
    workspaceId,
    canvasId,
    withMessage = true,
  }: { action: SteerAction; workspaceId: string; canvasId: string | null; withMessage?: boolean },
): Promise<void> {
  await askSteerGates(c.var.deps, {
    action,
    userId: c.var.actor.user.id,
    workspaceId,
    canvasId,
    withMessage,
    request: c.req.raw,
  });
}

import {
  canvasBillingGate,
  type EventKind,
  getMemberWorkspace,
  getWorkspace,
  readWorkspaceUsage,
  type WakeContext,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import type { JobDeps } from "../jobs/run.ts";
import { type BillingGate, BLOCKER_OF } from "./gate.ts";
import { billingPeriod } from "./period.ts";
import { gateOf } from "./reading.ts";

/*
 * Where the cached billing gate holds work back (docs/cloud.md, "Billing"), each reading
 * `workspaces.billing_gate` and never Stripe:
 *
 *   a person's steer   POST /v1/canvases with a first message and POST /v1/canvases/:id/messages
 *                      answer 402 `billing_required`, with nothing written
 *   the wake           the canvas waits on `credits_used_up`, `cap_reached` or `payment_failed`
 *                      (a wake for `push` is let through, so finished work can always be pushed)
 *   the runner's claim hands out only a stop, an answer, an edit and a push, so the turn that is
 *                      running finishes and no new one begins
 *
 * PONZU_BILLING decides how much of that happens:
 *
 *   off      none of it, and nothing here reads the database
 *   observe  nothing is refused; what would have been is logged (`billing_gate_would_refuse`), and
 *            a person's steer is captured as `billing wall hit` with `enforced: false`
 *   on       all of it
 *
 * An answer to a question is never refused: a question is asked by a turn, and the turn waits on
 * the answer, so refusing it would cut short the turn that is running.
 */

/** A workspace a refusal is about, as its words name it. */
export interface RefusalWorkspace {
  name: string;
  /** A personal workspace's own person reads "You've" and "Your" instead of its name. */
  you: boolean;
}

/** "$100": a cap, in whole dollars. */
function capDollars(cents: number): string {
  return `$${Math.floor(cents / 100).toLocaleString("en-US")}`;
}

/** The 402's message (billing §11), also the iPhone's line under its composer. */
export function refusalMessage(
  gate: Exclude<BillingGate, "ok">,
  workspace: RefusalWorkspace,
  capCents: number,
): string {
  switch (gate) {
    case "free_used":
      return workspace.you
        ? "You've used this month's free credits."
        : `${workspace.name} has used this month's free credits.`;
    case "cap_reached":
      return workspace.you
        ? `You've reached this month's ${capDollars(capCents)} cap.`
        : `${workspace.name} has reached this month's ${capDollars(capCents)} cap.`;
    case "payment_failed":
      return workspace.you
        ? "Your last payment didn't go through."
        : `${workspace.name}'s last payment didn't go through.`;
  }
}

/** What a person's steer is, as far as billing asks. */
export interface BillingSteer {
  action: "create" | "message" | "answer";
  userId: string;
  workspaceId: string;
  withMessage: boolean;
}

/**
 * The steer gate's billing check: throws the 402 when the workspace's gate holds new work back
 * and billing is on. Reads nothing while billing is off, nor for a create without a message or an
 * answer. Writes nothing in any mode.
 */
export async function refuseSteerAtLimit(deps: Deps, steer: BillingSteer): Promise<void> {
  if (deps.features.billing === "off" || !steer.withMessage || steer.action === "answer") return;
  const workspace = await getWorkspace(deps.db, steer.workspaceId);
  if (!workspace || workspace.billingGate === "ok") return;
  const gate = workspace.billingGate;
  const member = await getMemberWorkspace(deps.db, {
    userId: steer.userId,
    workspaceId: steer.workspaceId,
  });
  const canManage = member?.role === "admin";
  const enforced = deps.features.billing === "on";
  deps.analytics.capture(
    "billing wall hit",
    { reason: gate, surface: steer.action, can_manage: canManage, enforced },
    { workspaceId: workspace.id },
  );
  const fields = { workspaceId: workspace.id, reason: gate, surface: steer.action };
  if (!enforced) {
    deps.log.info("billing_gate_would_refuse", fields);
    return;
  }
  deps.log.info("billing_gate_refused", fields);

  const now = new Date(deps.clock.now());
  const period = billingPeriod(workspace.billingPeriodAnchor, now);
  const read = await readWorkspaceUsage(deps.db, {
    workspaceId: workspace.id,
    viewerId: steer.userId,
    start: period.start,
    end: period.end,
    now,
  });
  const reading = read ? gateOf(workspace, period, read, now) : null;
  const capCents = reading?.capCents ?? workspace.monthlyCapCents ?? 0;
  const you = workspace.kind === "personal" && canManage;
  throw new ApiError(
    402,
    "billing_required",
    refusalMessage(gate, { name: workspace.name, you }, capCents),
    {
      details: {
        reason: gate,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        canManage,
        capUsd: Math.floor(capCents / 100),
        billedCents: reading?.billedCents ?? 0,
        periodEnd: period.end.toISOString(),
        // What to pay, for whoever may pay it; a member asks an admin.
        invoiceUrl: canManage ? workspace.pastDueInvoiceUrl : null,
      },
    },
  );
}

/**
 * The wake gate's billing check, from the wake's context (which reads the cached gate with the
 * canvas). Null lets the wake through: always while billing is off, for a `push`, and in observe,
 * which logs what it would have held.
 */
export function holdWakeAtLimit(
  ctx: WakeContext,
  {
    deps,
    reason,
  }: { deps: Pick<JobDeps, "features" | "log" | "analytics">; reason: string | null },
): { blocker: (typeof BLOCKER_OF)[keyof typeof BLOCKER_OF] } | null {
  // A push is let through whatever wake carries it: a wake already waiting for a comment or a
  // check takes in a push asked for after it, and only a push goes out at the claim anyway.
  const forPush = reason === "push" || ctx.pushWaiting;
  if (deps.features.billing === "off" || ctx.billingGate === "ok" || forPush) return null;
  const gate = ctx.billingGate;
  const blocker = BLOCKER_OF[gate];
  if (deps.features.billing === "observe") {
    deps.log.info("billing_gate_would_refuse", {
      workspaceId: ctx.workspaceId,
      canvasId: ctx.canvasId,
      reason: gate,
      surface: "wake",
    });
    return null;
  }
  // Once each time the canvas starts waiting on billing, not at every wake that finds it so.
  if (ctx.agentBlocker !== blocker) {
    deps.analytics.capture(
      "canvas waiting on billing",
      { canvas_id: ctx.canvasId, reason: gate },
      { distinctId: null, workspaceId: ctx.workspaceId },
    );
  }
  return { blocker };
}

/**
 * What a runner may take up while its workspace is at a billing limit: a stop, a person's edit
 * (read with the next turn), the answer a running turn waits on, and a push (no turn; the wake
 * for one is let through too). Everything else stays in the feed, not delivered and so not owed.
 */
export const AT_A_BILLING_LIMIT: readonly EventKind[] = ["stop", "answer", "edit", "push"];

/**
 * The kinds billing lets the claim hand out now, or "all". Reads nothing while billing is not on.
 */
export async function billingClaimableKinds(
  deps: Pick<JobDeps, "db" | "features">,
  canvasId: string,
): Promise<readonly EventKind[] | "all"> {
  if (deps.features.billing !== "on") return "all";
  const gate = await canvasBillingGate(deps.db, canvasId);
  return gate && gate !== "ok" ? AT_A_BILLING_LIMIT : "all";
}

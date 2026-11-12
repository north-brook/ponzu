import { type AgentBlocker, claudeLimitedUntil, type EventKind, type WakeContext } from "@ponzu/db";
import { wakesPaused } from "../http/maintenance.ts";
import type { JobDeps } from "../jobs/run.ts";
import { claudeProblem } from "./environment.ts";

/*
 * What may keep a canvas's sandbox from waking, and its runner from taking up what is in its
 * feed (docs/cloud.md, "The sandbox"). Each feature that can hold a canvas back fills its own
 * gate here, and nothing else in the wake changes:
 *
 *   owner         its owner, whose Claude it runs on, left the workspace
 *   claude        its Claude is not connected, or has expired
 *   maintenance   Ponzu has paused wakes while it updates
 *   billing       the workspace is at a billing limit                (filled by W6 B2)
 *   claudeLimit   its owner's Claude plan is at a limit until a time (filled by W8 sweep 6)
 *
 * `wakeCanvas` asks them in this order before it claims the sandbox's row. The first that
 * answers decides: the canvas's head says what it waits on (`agent_blocker`) and until when
 * (`agent_blocked_until`, the answer's `retryAt`), the rest are not asked, and the wake is
 * tried again at `retryAt` when one is given. Otherwise the wake is over until something else
 * starts one (`resumeBlocked`, or the next message). Only once every gate lets it through
 * does the wake go on.
 */

/** A gate's refusal: what the canvas waits on, and when to try the wake again, if known. */
export interface WakeRefusal {
  blocker: AgentBlocker;
  retryAt?: Date;
}

/** What a wake is, besides the canvas: what it may read, and why it was asked for. */
export interface WakeAsk {
  deps: JobDeps;
  /** The wake's reason as it was recorded (`message`, `push`, `claude`, …); null if none. */
  reason: string | null;
}

/** One gate: null lets the wake through. It reads only what it is given, and writes nothing. */
export type WakeGate = (ctx: WakeContext, now: Date, ask: WakeAsk) => WakeRefusal | null;

/**
 * The owner left the workspace: someone who has left lends their Claude to nothing there.
 * Asked before `claude`, so that a canvas whose owner has gone says so whatever their Claude's
 * state, as the wake always has.
 */
export const ownerGate: WakeGate = (ctx) =>
  ctx.ownerMember ? null : { blocker: "claude_owner_left" };

/** The Claude it runs on is not connected, or has expired. */
export const claudeGate: WakeGate = (ctx, now) => {
  const blocker = claudeProblem(ctx.claude, now.getTime());
  return blocker ? { blocker } : null;
};

/** How long a wake that maintenance holds waits before it is tried again. */
export const MAINTENANCE_RETRY_MS = 2 * 60_000;

/**
 * Ponzu has paused wakes while it updates (`PONZU_MAINTENANCE` is `wakes_paused` or
 * `read_only`, http/maintenance.ts): the canvas waits on `paused`, and the wake is tried again
 * in two minutes, as a busy sandbox's is, so what was sent goes in once the switch is off. A
 * wake that runs out of tries is picked up by the cron's `maintenance` step, which lifts
 * `paused` once the switch is off.
 *
 * A sandbox already awake has nothing to wake: its runner takes up what was sent by itself (a
 * message's wake only pokes it), so the gate lets it through rather than have the head say the
 * agent is paused while it answers.
 */
export const maintenanceGate: WakeGate = (ctx, now, { deps }) => {
  if (!wakesPaused(deps.features) || ctx.sandbox?.state === "awake") return null;
  return { blocker: "paused", retryAt: new Date(now.getTime() + MAINTENANCE_RETRY_MS) };
};

/** How long past a plan's reset its canvases wait before they wake: a little slack for clocks. */
export const LIMIT_GRACE_MS = 30_000;

/**
 * The Claude plan it runs on is at its limit (docs/cloud.md, "Claude plan limits"): it waits
 * for everyone until the plan resets, and its wake is tried again `LIMIT_GRACE_MS` after that.
 * The head says it waits until then too, which the apps show to the minute. A turn already
 * running is never cut: only a wake is held. The account's `limited_until` is written only from
 * what a runner on its current credential reported, and cleared when a person connects again.
 */
export const claudeLimitGate: WakeGate = (ctx, now) => {
  const until = ctx.claude?.limitedUntil;
  if (!until || until.getTime() <= now.getTime()) return null;
  return { blocker: "claude_limited", retryAt: new Date(until.getTime() + LIMIT_GRACE_MS) };
};

export interface NamedWakeGate {
  name: string;
  gate: WakeGate;
}

export const WAKE_GATES: readonly NamedWakeGate[] = [
  { name: "owner", gate: ownerGate },
  { name: "claude", gate: claudeGate },
  { name: "maintenance", gate: maintenanceGate },
  { name: "billing", gate: () => null },
  { name: "claudeLimit", gate: claudeLimitGate },
];

/**
 * What the wake gates make of a wake: the first refusal, with the gate that gave it, or null
 * when every gate lets it through. The gates after a refusal are not asked.
 */
export function askWakeGates(
  ctx: WakeContext,
  now: Date,
  ask: WakeAsk,
  gates: readonly NamedWakeGate[] = WAKE_GATES,
): (WakeRefusal & { gate: string }) | null {
  for (const { name, gate } of gates) {
    const refusal = gate(ctx, now, ask);
    if (refusal) return { ...refusal, gate: name };
  }
  return null;
}

/**
 * The blockers a gate gives that the canvas's head keeps after the gate has stopped giving it,
 * until a wake that passes every gate (or `resumeBlocked`) lifts it. Claude's own are lifted
 * where Claude is connected (`connectClaude`), and the sandbox's by the wake that starts it.
 */
export const LIFTED_BY_A_WAKE: ReadonlySet<AgentBlocker> = new Set([
  "paused",
  "credits_used_up",
  "cap_reached",
  "payment_failed",
  "claude_limited",
]);

/** What a runner's claim is for: the one canvas it holds the lease of. */
export interface ClaimContext {
  canvasId: string;
}

/**
 * Which kinds of event a runner's claim may hand out now: every kind, unless a feature holds
 * some back (billing, at a limit, hands out only a stop, an answer and an edit, so the turn
 * that is running finishes and no new one begins). What it holds back stays in the feed, not
 * delivered, and so not owed. Asynchronous, unlike a wake gate, because what it reads is not
 * in the claim's own statement; it is asked once per claim.
 */
export async function claimableKinds(
  deps: Pick<JobDeps, "db" | "clock">,
  ctx: ClaimContext,
): Promise<readonly EventKind[] | "all"> {
  const now = new Date(deps.clock.now());
  if (await claudeLimitedUntil(deps.db, { canvasId: ctx.canvasId, now })) return AT_A_CLAUDE_LIMIT;
  return "all";
}

/**
 * What a runner still awake may take up while the Claude plan it runs on is at its limit:
 * nothing that would begin a turn, which could only fail again. A stop, a person's edit (read
 * with the next turn) and a push (which needs no Claude) go out; the rest waits in the feed and
 * goes in once the plan resets, as the people who sent it were told.
 */
export const AT_A_CLAUDE_LIMIT: readonly EventKind[] = ["stop", "edit", "push"];

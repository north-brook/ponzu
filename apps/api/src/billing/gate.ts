/*
 * The billing gate: whether a workspace may start new work, from its numbers alone
 * (docs/cloud.md, "Billing"). It is a pure function. `refreshBillingGate` (refresh.ts) works it
 * out and caches it on the workspace; the routes, the wake and the runner's claim read the cached
 * answer (enforce.ts), and only while PONZU_BILLING is not off.
 *
 * The rules, checked in this order:
 *
 *   payment_failed  an invoice has been past due for the grace period or longer
 *   free_used       there is no card, and the free credits are used up (exactly used up counts)
 *   cap_reached     there is a card, and what is billed has reached the cap (exactly at it counts)
 *   ok              anything else
 *
 * A turn that is running when the gate closes is never cut off; the gate only stops new ones.
 */

import type { AgentBlocker } from "@ponzu/db";

export type BillingGate = "ok" | "free_used" | "cap_reached" | "payment_failed";

/** The blocker a canvas waits on for each gate that holds work back. */
export const BLOCKER_OF: Record<Exclude<BillingGate, "ok">, AgentBlocker> = {
  free_used: "credits_used_up",
  cap_reached: "cap_reached",
  payment_failed: "payment_failed",
};

/** Every blocker billing gives, which `resumeBillingBlocked` lifts. */
export const BILLING_BLOCKERS: readonly AgentBlocker[] = Object.values(BLOCKER_OF);

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an invoice may stay unpaid before new turns stop: 7 days, to the millisecond. */
export const GRACE_MS = 7 * DAY_MS;

export interface BillingGateInput {
  /** Credits used this period, whole (`creditsOf`). */
  usedCredits: number;
  /** The period's pooled free credits. */
  freeCredits: number;
  /** What is billed this period, in cents, before any cap (`centsFor` of the billed credits). */
  billedCents: number;
  /** The workspace's monthly cap, in cents. */
  capCents: number;
  /** Whether the workspace has a card on file. */
  hasCard: boolean;
  /** When an invoice of the workspace first went past due, or null when none is. */
  pastDueSince: Date | null;
  now: Date;
  /** Normally `GRACE_MS`; passed in so a test can name the boundary. */
  graceMs: number;
}

export function billingGate(i: BillingGateInput): BillingGate {
  if (i.pastDueSince && i.now.getTime() - i.pastDueSince.getTime() >= i.graceMs) {
    return "payment_failed";
  }
  if (!i.hasCard && i.usedCredits >= i.freeCredits) return "free_used";
  if (i.hasCard && i.billedCents >= i.capCents) return "cap_reached";
  return "ok";
}

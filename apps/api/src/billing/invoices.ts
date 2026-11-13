import {
  type AppliedInvoiceState,
  applyInvoiceState,
  clearPastDueIfSettled,
  type InvoiceStateUpdate,
  setPastDue,
} from "@ponzu/db";
import type { InvoiceState } from "../deps/payments.ts";
import { notify } from "../notifications/notify.ts";
import { type RefreshDeps, refreshBillingGate } from "./refresh.ts";

/*
 * A period's invoice, as Stripe says it is now (docs/cloud.md, "Billing", "Failed payments").
 * The close stores what Stripe answered when it charged the period, and every invoice webhook's
 * job reads the invoice fresh and stores that, so late or out-of-order deliveries cannot move a
 * period backwards (`applyInvoiceState` never takes a status back).
 *
 * What follows from it: a failed payment, or one the bank asks the payer to confirm, marks the
 * workspace past due (`past_due_at`, kept from the first time, with the reason and the invoice's
 * page) and pings its admins once for the period; after `GRACE_MS` unpaid the gate stops new
 * turns. A paid or voided invoice clears past due once no other period's invoice is unpaid. Every
 * change works the gate out again, which wakes what it held back once it opens.
 *
 * None of this runs unless PONZU_BILLING is `on`: the close only charges then, and the webhook's
 * job does nothing otherwise.
 */

/** The status Stripe's invoice gives its period; a draft gives none (the close is not done). */
export function periodStatusOf(state: InvoiceState): InvoiceStateUpdate["status"] | null {
  switch (state.status) {
    case "draft":
      return null;
    case "paid":
    case "void":
    case "uncollectible":
      return state.status;
    case "open":
      // An open invoice Stripe has tried to collect and could not (or that waits on the payer's
      // bank) has failed a payment; one not yet tried is simply invoiced.
      return state.attemptCount > 0 || state.needsAction ? "payment_failed" : "invoiced";
  }
}

/**
 * Store what the invoice says now, and act on the change. Null when it is a draft (nothing to
 * store yet) or no period of the workspace names it.
 */
export async function applyInvoice(
  deps: RefreshDeps,
  workspaceId: string,
  state: InvoiceState,
): Promise<AppliedInvoiceState | null> {
  const status = periodStatusOf(state);
  if (!status) return null;
  const now = new Date(deps.clock.now());
  const applied = await applyInvoiceState(deps.db, {
    workspaceId,
    stripeInvoiceId: state.id,
    status,
    attempts: state.attemptCount,
    nextAttemptAt: state.nextPaymentAttemptAt,
    invoiceNumber: state.number,
    hostedInvoiceUrl: state.hostedInvoiceUrl,
    taxCents: state.taxCents,
    totalCents: state.totalCents,
    at: now,
  });
  if (!applied) {
    deps.log.warn("stripe_invoice_unknown", { workspaceId, invoiceId: state.id });
    return null;
  }
  const { before, after } = applied;
  if (before !== after) {
    deps.log.info("billing_period_status", {
      workspaceId,
      periodStart: applied.periodStart.toISOString(),
      before,
      after,
    });
  }
  const reason = state.needsAction ? "needs_confirmation" : "failed";
  const group = { distinctId: null, workspaceId };

  if (after === "payment_failed" || after === "uncollectible") {
    await setPastDue(deps.db, {
      workspaceId,
      reason,
      invoiceUrl: state.hostedInvoiceUrl,
      at: now,
    });
  }
  if (after === "payment_failed" && applied.attempts > applied.attemptsBefore) {
    deps.analytics.capture("invoice payment failed", { attempt: applied.attempts, reason }, group);
  }
  if (after === "payment_failed") {
    // Once a period: the notification's dedupe key (the notice, the workspace and the period)
    // keeps it to one row a person however often this runs. It is asked on every failed read,
    // not only the first, so a job that stored the failure and stopped before this still pings
    // when it is tried again.
    const amountCents = applied.totalCents ?? applied.chargedCents;
    await notify(deps, {
      kind: "billing",
      workspaceId,
      periodStart: applied.periodStart.toISOString(),
      notice: "payment_failed",
      amountCents,
    });
  }
  if (applied.firstFailure) {
    deps.analytics.capture("billing notice", { kind: "payment_failed" }, group);
  }
  if (after === "paid" || after === "void") {
    // On every read that finds it settled, not only the first: a job that stored `paid` and
    // stopped before this ran is tried again, and finds the status already moved.
    await clearPastDueIfSettled(deps.db, { workspaceId });
  }
  if (after === "paid" && before !== "paid") {
    deps.analytics.capture(
      "invoice paid",
      { charged_cents: applied.chargedCents, attempts: applied.attempts },
      group,
    );
  }
  // Past due set or cleared, or the grace ran out meanwhile: the gate follows, and wakes what it
  // held back when it opens.
  await refreshBillingGate(deps, workspaceId);
  return applied;
}

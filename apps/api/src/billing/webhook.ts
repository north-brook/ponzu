import { readCardSetup, workspaceForStripe } from "@ponzu/db";
import { z } from "zod";
import type { StripeEventRef } from "../deps/payments.ts";
import type { JobDeps } from "../jobs/run.ts";
import { settleFromStripe, syncCard } from "./cards.ts";

/*
 * Stripe's webhooks (docs/cloud.md, "Billing", "Webhooks"). The route checks the signature over
 * the raw body, drops what is another deployment's, and records each event this file acts on as
 * a job keyed by the event's id, in one statement with the delivery (`takeWebhookDelivery`), so
 * a delivery Stripe sends again is acknowledged and dropped. The job does the work.
 *
 * A delivery is a signal, not a record. Stripe sends events late, twice and out of order, so
 * nothing here writes what an event's body says: the job reads the Checkout session or the
 * customer's card from Stripe as it is now and applies that, so a late event can never move a
 * workspace backwards. Invoices are the period close's, and not acted on yet.
 */

/** The events acted on, and what each asks for. */
export const STRIPE_EVENTS = {
  "checkout.session.completed": "card_setup",
  "checkout.session.expired": "card_setup",
  "customer.updated": "card",
  "payment_method.attached": "card",
  "payment_method.detached": "card",
  "charge.dispute.created": "note",
  "charge.refunded": "note",
} as const satisfies Record<string, "card_setup" | "card" | "note">;

export type StripeEventType = keyof typeof STRIPE_EVENTS;

export function isActedOn(type: string): type is StripeEventType {
  return Object.hasOwn(STRIPE_EVENTS, type);
}

/** The job an event's work is recorded as, keyed by the event's id (`jobs/run.ts`). */
export const STRIPE_WEBHOOK_JOB = "stripe_webhook";
/** Attempts an event's work gets: with the retry waits, a little over two hours of them. */
export const STRIPE_WEBHOOK_JOB_ATTEMPTS = 8;

const StripeJob = z.object({
  eventId: z.string(),
  type: z.string(),
  objectId: z.string().nullable(),
  customerId: z.string().nullable(),
  /** Our marks on the object, when it carries any: the setup and workspace it names. */
  setupId: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

/** What an event's job holds: ids only, never the event's body. */
export type StripeJobPayload = z.infer<typeof StripeJob>;

/** What a job keeps of an event. */
export function stripeJobPayload(event: StripeEventRef): StripeJobPayload {
  return {
    eventId: event.id,
    type: event.type,
    objectId: event.objectId,
    customerId: event.customerId,
    setupId: event.metadata.ponzu_setup_id ?? null,
    workspaceId: event.metadata.ponzu_workspace_id ?? null,
  };
}

/** Do an event's work from its job. */
export async function runStripeWebhookJob(deps: JobDeps, stored: unknown): Promise<void> {
  const job = StripeJob.parse(stored);
  if (deps.features.billing !== "on" || !deps.payments.enabled) {
    // Billing was turned off after the event was taken: nothing may ask Stripe now.
    deps.log.info("stripe_webhook_skipped", { eventId: job.eventId, reason: "billing_off" });
    return;
  }
  if (!isActedOn(job.type)) {
    deps.log.warn("stripe_webhook_skipped", { eventId: job.eventId, reason: "not_acted_on" });
    return;
  }
  switch (STRIPE_EVENTS[job.type]) {
    case "card_setup":
      return checkoutEnded(deps, job);
    case "card":
      return cardChanged(deps, job);
    case "note":
      // The founder works disputes and refunds in Stripe's dashboard: no effect on the product.
      deps.log.info(job.type === "charge.refunded" ? "billing_refund" : "billing_dispute", {
        eventId: job.eventId,
        objectId: job.objectId,
        customerId: job.customerId,
      });
      return;
  }
}

/** A Checkout page in setup mode was finished or expired: settle its setup by what Stripe says. */
async function checkoutEnded(deps: JobDeps, job: StripeJobPayload) {
  const setup = job.setupId === null ? null : await readCardSetup(deps.db, { id: job.setupId });
  if (!setup || setup.payload.workspaceId !== job.workspaceId || job.objectId === null) {
    // A Checkout page of ours always names its setup and workspace: this one is someone else's.
    deps.log.info("stripe_webhook_skipped", { eventId: job.eventId, reason: "no_card_setup" });
    return;
  }
  // The event's own session: a setup replaced by a newer one can still have its card finished.
  const settled = await settleFromStripe(deps, setup, { sessionId: job.objectId });
  // Stripe down: the job is tried again later.
  if (settled.unreachable) throw new Error("Stripe could not be reached to read a Checkout page.");
}

/** The customer, or one of its cards, changed at Stripe: bring the stored card in line. */
async function cardChanged(deps: JobDeps, job: StripeJobPayload) {
  const workspaceId = await workspaceForStripe(deps.db, {
    customerId: job.customerId,
    paymentMethodId: job.type.startsWith("payment_method.") ? job.objectId : null,
  });
  if (!workspaceId) {
    // No workspace here has this customer or card: another deployment's, or made by hand.
    deps.log.info("stripe_webhook_skipped", { eventId: job.eventId, reason: "not_ours" });
    return;
  }
  await syncCard(deps, workspaceId);
}

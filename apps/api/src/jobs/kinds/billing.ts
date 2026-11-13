import { runStripeWebhookJob, STRIPE_WEBHOOK_JOB } from "../../billing/webhook.ts";
import type { JobKinds } from "../registry.ts";

/** Billing's jobs: Stripe's webhook events, each worked on as its own job. */
export const billingJobs = (): JobKinds => ({
  [STRIPE_WEBHOOK_JOB]: runStripeWebhookJob,
});

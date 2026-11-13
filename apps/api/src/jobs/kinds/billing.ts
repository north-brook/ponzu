import { CLOSE_JOB, runCloseJob } from "../../billing/close.ts";
import { runStripeWebhookJob, STRIPE_WEBHOOK_JOB } from "../../billing/webhook.ts";
import type { JobKinds } from "../registry.ts";

/** Billing's jobs: Stripe's webhook events, each worked on as its own job, and period closes. */
export const billingJobs = (): JobKinds => ({
  [STRIPE_WEBHOOK_JOB]: runStripeWebhookJob,
  [CLOSE_JOB]: runCloseJob,
});

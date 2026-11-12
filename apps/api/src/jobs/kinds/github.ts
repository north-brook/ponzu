import { runWebhookJob, WEBHOOK_JOB } from "../../github/webhook.ts";
import type { JobKinds } from "../registry.ts";

/** GitHub's webhook deliveries, each worked on as its own job. */
export const githubJobs = (): JobKinds => ({
  [WEBHOOK_JOB]: runWebhookJob,
});

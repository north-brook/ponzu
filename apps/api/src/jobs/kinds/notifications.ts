import { BADGE_JOB, runBadgeJob } from "../../notifications/badge.ts";
import { DELIVER_JOB, runDeliverJob } from "../../notifications/deliver.ts";
import { DIGEST_JOB, runDigestJob } from "../../notifications/digest.ts";
import { NOTIFY_JOB, runNotifyJob } from "../../notifications/notify.ts";
import type { JobKinds } from "../registry.ts";

/**
 * Notifications: who hears of something, the pushes that tell them, the phone's badge, and the
 * daily email.
 */
export const notificationJobs = (): JobKinds => ({
  [NOTIFY_JOB]: runNotifyJob,
  [DELIVER_JOB]: runDeliverJob,
  [BADGE_JOB]: runBadgeJob,
  [DIGEST_JOB]: runDigestJob,
});

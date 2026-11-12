import { BADGE_JOB, runBadgeJob } from "../../notifications/badge.ts";
import { DELIVER_JOB, runDeliverJob } from "../../notifications/deliver.ts";
import { NOTIFY_JOB, runNotifyJob } from "../../notifications/notify.ts";
import type { JobKinds } from "../registry.ts";

/** Notifications: who hears of something, the pushes that tell them, and the phone's badge. */
export const notificationJobs = (): JobKinds => ({
  [NOTIFY_JOB]: runNotifyJob,
  [DELIVER_JOB]: runDeliverJob,
  [BADGE_JOB]: runBadgeJob,
});

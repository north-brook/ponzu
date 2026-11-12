import {
  NOTIFICATION_EXPIRES_MS,
  NOTIFICATION_KEPT_MS,
  pruneDevices,
  pruneNotifications,
} from "@ponzu/db";
import { DEVICE_FRESH_MS } from "../../notifications/plan.ts";
import type { CronStep } from "../steps.ts";

/** How long a Mac may go unseen before it is forgotten. */
export const MAC_KEPT_MS = 30 * 24 * 60 * 60_000;

/**
 * Every ten minutes: unread notifications past three days are read as `expired` and leave the
 * inbox; notifications past thirty days go, with their deliveries; an iPhone unseen for ninety
 * days and a Mac unseen for thirty are forgotten.
 */
export const pruneNotificationsStep: CronStep = {
  name: "prune_notifications",
  everyMinutes: 10,
  run: async (deps, now) => {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const { expired, deleted } = await pruneNotifications(deps.db, {
      now,
      expireBefore: ago(NOTIFICATION_EXPIRES_MS),
      deleteBefore: ago(NOTIFICATION_KEPT_MS),
    });
    const devices = await pruneDevices(deps.db, {
      iosUnseenBefore: ago(DEVICE_FRESH_MS),
      macUnseenBefore: ago(MAC_KEPT_MS),
    });
    return { expired, deleted, devices };
  },
};

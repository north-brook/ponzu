import {
  type DeliveryUpdate,
  forgetDevicesUnseenSince,
  markDeliveries,
  receiptsDue,
  settleLostSends,
} from "@ponzu/db";
import { PUSH_RECEIPTS_LIMIT, pushErrorOf } from "../deps/push.ts";
import type { JobDeps } from "../jobs/run.ts";

/*
 * What became of the pushes Expo took (docs/cloud.md, "Notifications"), read by the minute's
 * cron. Expo answers a push with a ticket at once and a receipt, saying whether Apple took it,
 * some time later: they are read once `RECEIPT_AFTER_MS` has passed.
 *
 * - `ok`: `delivered`.
 * - An error: `failed`, with Expo's code. `DeviceNotRegistered` also forgets the phone, unless
 *   it has registered or been used since the push went (it may hold a new token now; the next
 *   push's ticket says plainly whether that one is dead). `InvalidCredentials` is an error worth
 *   waking someone for.
 * - No receipt yet: asked again next minute, until `RECEIPT_GIVE_UP_MS`, then `unknown`.
 *
 * It also settles pushes whose send was never answered (a 5xx, a timeout, an instance that died
 * mid-request): those are never sent again, and after `LOST_SEND_MS` they are `unknown`.
 */

/** How long after a push its receipt is first asked for: Expo's own advice. */
export const RECEIPT_AFTER_MS = 15 * 60_000;
/** How long a push may go without a receipt before it is `unknown`. */
export const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;
/** How long a send may stay unanswered before it is `unknown`: well past the seam's deadline. */
export const LOST_SEND_MS = 5 * 60_000;

export async function checkPushReceipts(
  deps: Pick<JobDeps, "db" | "log" | "push" | "analytics">,
  now: Date,
): Promise<Record<string, number>> {
  const { db, log } = deps;
  const lost = await settleLostSends(db, {
    before: new Date(now.getTime() - LOST_SEND_MS),
    now,
  });
  if (lost > 0) log.warn("push_lost", { count: lost });
  if (!deps.push.enabled) return { lost };

  const due = await receiptsDue(db, {
    before: new Date(now.getTime() - RECEIPT_AFTER_MS),
    limit: PUSH_RECEIPTS_LIMIT,
  });
  if (due.length === 0) return { lost };
  let receipts: Awaited<ReturnType<JobDeps["push"]["receipts"]>>;
  try {
    receipts = await deps.push.receipts(due.map((delivery) => delivery.ticketId));
  } catch (error) {
    // Reading is safe to repeat: the next minute asks again.
    log.warn("push_receipts_unavailable", { failure: pushErrorOf(error).code });
    return { lost, unavailable: 1 };
  }

  const updates: DeliveryUpdate[] = [];
  const dead: { id: string; sentAt: Date }[] = [];
  const counts = { delivered: 0, failed: 0, unknown: 0, waiting: 0 };
  for (const delivery of due) {
    const receipt = receipts[delivery.ticketId];
    if (!receipt) {
      if (now.getTime() - delivery.sentAt.getTime() > RECEIPT_GIVE_UP_MS) {
        updates.push({
          id: delivery.id,
          state: "unknown",
          outcome: "no_receipt",
          receiptCheckedAt: now,
        });
        counts.unknown++;
      } else counts.waiting++;
      continue;
    }
    if (receipt.ok) {
      updates.push({ id: delivery.id, state: "delivered", receiptCheckedAt: now });
      counts.delivered++;
      continue;
    }
    updates.push({
      id: delivery.id,
      state: "failed",
      outcome: receipt.error,
      receiptCheckedAt: now,
    });
    counts.failed++;
    log.warn("push_receipt_error", { deliveryId: delivery.id, error: receipt.error });
    deps.analytics.capture(
      "push failed",
      { kind: delivery.kind, error: receipt.error },
      { distinctId: null },
    );
    if (receipt.error === "DeviceNotRegistered" && delivery.deviceId) {
      dead.push({ id: delivery.deviceId, sentAt: delivery.sentAt });
    }
    if (receipt.error === "MessageTooBig") {
      log.error("push_too_big", { deliveryId: delivery.id });
    }
    if (receipt.error === "InvalidCredentials") {
      log.error("push_credentials_invalid", { deliveryId: delivery.id });
      deps.analytics.exception(new Error("Expo refused Ponzu's push credentials."), {
        push: "receipt",
      });
    }
  }
  await markDeliveries(db, updates);
  const forgotten = await forgetDevicesUnseenSince(db, dead);
  if (forgotten > 0) log.info("device_unregistered", { count: forgotten, via: "receipt" });
  return { lost, ...counts, forgotten };
}

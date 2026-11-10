import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { webhookDeliveries } from "../schema/index.ts";
import { run } from "./run.ts";

type Delivery = typeof webhookDeliveries.$inferInsert;

/**
 * Take a delivery for processing. True the first time its id is seen; false for a redelivery
 * or a retry of one already taken, which the caller acknowledges and drops.
 */
export async function recordWebhookDelivery(
  db: Db,
  delivery: Pick<Delivery, "source" | "deliveryId" | "event">,
): Promise<boolean> {
  const recorded = await run(
    db
      .insert(webhookDeliveries)
      .values(delivery)
      .onConflictDoNothing()
      .returning({ deliveryId: webhookDeliveries.deliveryId }),
  );
  return recorded.length > 0;
}

/** Give a delivery back after processing it failed, so that redelivering it runs it again. */
export async function forgetWebhookDelivery(
  db: Db,
  { source, deliveryId }: Pick<Delivery, "source" | "deliveryId">,
): Promise<void> {
  await run(
    db
      .delete(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.source, source), eq(webhookDeliveries.deliveryId, deliveryId)),
      ),
  );
}

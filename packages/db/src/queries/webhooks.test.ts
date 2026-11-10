import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb } from "../testing.ts";
import { forgetWebhookDelivery, recordWebhookDelivery } from "./webhooks.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("a delivery is taken the first time only, until it is given back", async () => {
  const delivery = { source: "github" as const, deliveryId: "d-1", event: "installation" };

  expect(await recordWebhookDelivery(db, delivery)).toBe(true);
  expect(await recordWebhookDelivery(db, delivery)).toBe(false);
  // The same id from another sender is another delivery.
  expect(await recordWebhookDelivery(db, { ...delivery, source: "stripe" })).toBe(true);

  await forgetWebhookDelivery(db, delivery);

  expect(await recordWebhookDelivery(db, delivery)).toBe(true);
});

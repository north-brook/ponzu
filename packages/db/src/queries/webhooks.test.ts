import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { takeWebhookDelivery } from "./webhooks.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const job = {
  kind: "github_webhook",
  payload: { event: "installation", payload: { note: "nul \u0000 here" } },
  runAt: new Date("2026-11-10T12:00:00Z"),
  lockedBy: "request:one",
  maxAttempts: 8,
};

test("a delivery is taken once, and its work recorded as a held job in the same statement", async () => {
  const delivery = { source: "github" as const, deliveryId: "d-1", event: "installation" };

  const jobId = await takeWebhookDelivery(db, { delivery, job });

  expect(jobId).toMatch(/^job_/);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId!));
  expect(row).toMatchObject({
    kind: "github_webhook",
    key: "d-1",
    runAt: job.runAt,
    attempts: 1,
    maxAttempts: 8,
    lockedBy: "request:one",
    payload: { event: "installation", payload: { note: "nul � here" } },
  });
  expect(row!.lockedAt).toBeInstanceOf(Date);

  // A redelivery, or GitHub retrying the same one: nothing is taken and no job is added.
  expect(await takeWebhookDelivery(db, { delivery, job })).toBeNull();
  expect(await db.$count(jobs, eq(jobs.key, "d-1"))).toBe(1);
  // The same id from another sender is another delivery.
  const stripe = { delivery: { ...delivery, source: "stripe" as const }, job };
  expect(
    await takeWebhookDelivery(db, { ...stripe, job: { ...job, kind: "stripe_webhook" } }),
  ).toMatch(/^job_/);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { seedUser } from "../fixtures.ts";
import { authStates, jobs, webhookDeliveries } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { onceId, readHeartbeat, recordHeartbeat } from "./jobs.ts";
import {
  AUTH_STATE_RETENTION_MS,
  JOB_RETENTION_DAYS,
  RETENTION_BATCH,
  sweepOldRows,
  WEBHOOK_RETENTION_DAYS,
} from "./retention.ts";

// Each test counts what is left, so each gets a database of its own.
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

const now = new Date("2026-11-12T10:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(now.getTime() - ms);

const ids = async (table: typeof authStates | typeof jobs) =>
  (await db.select({ id: table.id }).from(table)).map((row) => row.id).sort();

test("the periods are the ones the privacy draft states", () => {
  // apps/web/app/(legal)/privacy/page.mdx says these, and apps/web/legal.test.ts pins its words:
  // a change here changes the policy.
  expect(AUTH_STATE_RETENTION_MS).toBe(24 * 3600_000);
  expect(JOB_RETENTION_DAYS).toBe(30);
  expect(WEBHOOK_RETENTION_DAYS).toBe(30);
});

test("expired sign-in states go a day after they expire, and not a moment before", async () => {
  const user = await seedUser(db);
  const state = (id: string, expiresAt: Date, consumedAt: Date | null = null) => ({
    id,
    kind: "github_install" as const,
    userId: user.id,
    expiresAt,
    consumedAt,
  });
  await db.insert(authStates).values([
    state("auth_open", new Date(now.getTime() + HOUR)),
    state("auth_expired_lately", ago(HOUR)),
    state("auth_at_the_boundary", ago(DAY)),
    state("auth_just_past", ago(DAY + 1)),
    // Taken, then expired long ago: its outcome has been read, if it ever will be.
    state("auth_taken_long_ago", ago(3 * DAY), ago(3 * DAY + HOUR)),
  ]);

  const swept = await sweepOldRows(db, now);

  expect(swept.authStates).toBe(2);
  expect(await ids(authStates)).toEqual([
    "auth_at_the_boundary",
    "auth_expired_lately",
    "auth_open",
  ]);
});

test("finished jobs go 30 days after they finished; waiting and running ones stay whatever their age", async () => {
  const old = ago(90 * DAY);
  await db.insert(jobs).values([
    { id: "job_completed_lately", kind: "k", completedAt: ago(DAY) },
    { id: "job_completed_at_boundary", kind: "k", completedAt: ago(30 * DAY) },
    { id: "job_completed_just_past", kind: "k", completedAt: ago(30 * DAY + 1) },
    { id: "job_failed_at_boundary", kind: "k", failedAt: ago(30 * DAY) },
    { id: "job_failed_long_ago", kind: "k", attempts: 5, failedAt: ago(31 * DAY) },
    // Never finished: still to run, or held, however long ago it was made or tried.
    { id: "job_waiting", kind: "k", runAt: old, createdAt: old },
    {
      id: "job_running",
      kind: "k",
      runAt: old,
      createdAt: old,
      lockedAt: old,
      lockedBy: "worker",
      attempts: 1,
    },
    // `recordOnce`'s mark for a cron hour long gone: a finished job like any other.
    {
      id: onceId("cron.step", "retention@2026-08-01T00:00:00.000Z"),
      kind: "cron.step",
      completedAt: old,
    },
  ]);

  const swept = await sweepOldRows(db, now);

  expect(swept.jobs).toBe(3);
  expect(await ids(jobs)).toEqual([
    "job_completed_at_boundary",
    "job_completed_lately",
    "job_failed_at_boundary",
    "job_running",
    "job_waiting",
  ]);
});

test("a heartbeat is kept however old it is, so a cron quiet for months reads as quiet, not as never", async () => {
  await recordHeartbeat(db, "cron.minute", ago(90 * DAY));

  const swept = await sweepOldRows(db, now);

  expect(swept.jobs).toBe(0);
  expect(await readHeartbeat(db, "cron.minute")).toEqual(ago(90 * DAY));
});

test("webhook records go 30 days after they arrived", async () => {
  const delivery = (deliveryId: string, receivedAt: Date) => ({
    source: "github" as const,
    deliveryId,
    event: "push",
    receivedAt,
  });
  await db
    .insert(webhookDeliveries)
    .values([
      delivery("lately", ago(DAY)),
      delivery("at_boundary", ago(30 * DAY)),
      delivery("just_past", ago(30 * DAY + 1)),
      { ...delivery("just_past", ago(40 * DAY)), source: "stripe" as const },
    ]);

  const swept = await sweepOldRows(db, now);

  expect(swept).toEqual({ authStates: 0, jobs: 0, webhookDeliveries: 2 });
  const left = await db
    .select({ source: webhookDeliveries.source, id: webhookDeliveries.deliveryId })
    .from(webhookDeliveries);
  expect(left.map((row) => `${row.source}:${row.id}`).sort()).toEqual([
    "github:at_boundary",
    "github:lately",
  ]);
});

test("a run deletes at most its batch from each table, and the next run takes the rest", async () => {
  const user = await seedUser(db);
  for (let i = 0; i < 7; i++) {
    await db.insert(authStates).values({
      id: `auth_${i}`,
      kind: "github_install",
      userId: user.id,
      expiresAt: ago(2 * DAY),
    });
    await db.insert(jobs).values({ id: `job_${i}`, kind: "k", completedAt: ago(60 * DAY) });
  }

  expect(await sweepOldRows(db, now, { limit: 3 })).toEqual({
    authStates: 3,
    jobs: 3,
    webhookDeliveries: 0,
  });
  expect(await sweepOldRows(db, now, { limit: 3 })).toEqual({
    authStates: 3,
    jobs: 3,
    webhookDeliveries: 0,
  });
  expect(await sweepOldRows(db, now, { limit: 3 })).toEqual({
    authStates: 1,
    jobs: 1,
    webhookDeliveries: 0,
  });
  expect(await sweepOldRows(db, now, { limit: 3 })).toEqual({
    authStates: 0,
    jobs: 0,
    webhookDeliveries: 0,
  });
});

test("the batch is 5,000 rows a run", async () => {
  expect(RETENTION_BATCH).toBe(5_000);
  await db.execute(sql`
    insert into webhook_deliveries (source, delivery_id, event, received_at)
    select 'github', 'd' || n, 'push', ${ago(31 * DAY).toISOString()}::timestamptz
      from generate_series(1, 5001) as n`);

  expect((await sweepOldRows(db, now, { limit: 10_000 })).webhookDeliveries).toBe(5_000);
  expect((await sweepOldRows(db, now)).webhookDeliveries).toBe(1);
  expect(await db.$count(webhookDeliveries)).toBe(0);
});

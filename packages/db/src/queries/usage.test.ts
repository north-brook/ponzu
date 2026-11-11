import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedDesign, seedUser } from "../fixtures.ts";
import { creditLedger, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  addLedgerEntry,
  ledgerBalance,
  type NewUsageEvent,
  recordTurnUsage,
  recordUsage,
} from "./usage.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const november = new Date("2026-11-01T00:00:00Z");
const december = new Date("2026-12-01T00:00:00Z");

let events = 0;
/** Twelve awake minutes: one credit at five credits an hour. */
function awake(
  seeded: Awaited<ReturnType<typeof seedDesign>>,
  overrides: Partial<NewUsageEvent> = {},
): NewUsageEvent {
  return {
    id: `use_test_${++events}`,
    workspaceId: seeded.workspace.id,
    designId: seeded.design.id,
    userId: seeded.user.id,
    kind: "sandbox",
    seconds: 720,
    credits: 1,
    costMicrousd: 0,
    payer: "ponzu",
    rateCardVersion: 1,
    occurredAt: new Date("2026-11-10T15:00:00Z"),
    periodStart: november,
    ...overrides,
  } as NewUsageEvent;
}

const ledgerOf = (workspaceId: string) =>
  db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));

test("awake time is recorded and its credits leave the ledger", async () => {
  const seeded = await seedDesign(db);
  const event = awake(seeded, { seconds: 1800, credits: 2.5 });

  expect(await recordUsage(db, event)).toBe(true);

  const [stored] = await db.select().from(usageEvents).where(eq(usageEvents.id, event.id));
  expect(stored).toMatchObject({
    kind: "sandbox",
    seconds: 1800,
    credits: 2.5,
    payer: "ponzu",
    rateCardVersion: 1,
    occurredAt: event.occurredAt,
    model: null,
  });
  expect(await ledgerOf(seeded.workspace.id)).toMatchObject([
    {
      delta: -2.5,
      reason: "use",
      periodStart: november,
      userId: seeded.user.id,
      usageEventId: event.id,
    },
  ]);
});

test("reporting an event again counts it once", async () => {
  const seeded = await seedDesign(db);
  const event = awake(seeded);

  expect(await recordUsage(db, event)).toBe(true);
  expect(await recordUsage(db, { ...event, credits: 50 })).toBe(false);

  expect(await ledgerOf(seeded.workspace.id)).toHaveLength(1);
  expect(
    await ledgerBalance(db, { workspaceId: seeded.workspace.id, periodStart: november }),
  ).toEqual({ granted: 0, used: 1, balance: -1 });
});

test("a model turn on the person's own plan is recorded and costs no credits", async () => {
  const seeded = await seedDesign(db);
  const event = awake(seeded, {
    kind: "model",
    model: "claude-opus",
    inputTokens: 12_000,
    outputTokens: 900,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 4_000,
    credits: 0,
    costMicrousd: 412_500,
    payer: "own_plan",
  });
  // A sandbox event's field, which a model event must not carry.
  delete (event as { seconds?: number }).seconds;

  expect(await recordUsage(db, event)).toBe(true);

  const [stored] = await db.select().from(usageEvents).where(eq(usageEvents.id, event.id));
  expect(stored).toMatchObject({
    kind: "model",
    model: "claude-opus",
    inputTokens: 12_000,
    cacheReadTokens: 80_000,
    costMicrousd: 412_500,
    credits: 0,
    payer: "own_plan",
    seconds: null,
  });
  expect(await ledgerOf(seeded.workspace.id)).toEqual([]);
});

test("the usage and the ledger entry are written together or not at all", async () => {
  const seeded = await seedDesign(db);
  // No such rate card: the event cannot be stored, so nothing may be spent either.
  await expect(recordUsage(db, awake(seeded, { rateCardVersion: 99 }))).rejects.toThrow();

  expect(await ledgerOf(seeded.workspace.id)).toEqual([]);
});

test("a member's allowance is granted once a period", async () => {
  const seeded = await seedDesign(db);
  const teammate = await seedUser(db, "maya");
  const grant = (userId: string, periodStart: Date) =>
    addLedgerEntry(db, {
      workspaceId: seeded.workspace.id,
      delta: 100,
      reason: "grant",
      periodStart,
      userId,
    });

  expect(await grant(seeded.user.id, november)).toBe(true);
  // Sign-in and the cron both try; the second finds it done.
  expect(await grant(seeded.user.id, november)).toBe(false);
  expect(await grant(teammate.id, november)).toBe(true);
  expect(await grant(seeded.user.id, december)).toBe(true);

  const balance = (periodStart: Date) =>
    ledgerBalance(db, { workspaceId: seeded.workspace.id, periodStart });
  expect(await balance(november)).toEqual({ granted: 200, used: 0, balance: 200 });
  expect(await balance(december)).toEqual({ granted: 100, used: 0, balance: 100 });
});

test("the balance is what was granted less what was used, a period at a time", async () => {
  const seeded = await seedDesign(db);
  const other = await seedDesign(db);
  const workspaceId = seeded.workspace.id;
  await addLedgerEntry(db, {
    workspaceId,
    delta: 100,
    reason: "grant",
    periodStart: november,
    userId: seeded.user.id,
  });
  await recordUsage(db, awake(seeded, { credits: 30.25 }));
  await recordUsage(db, awake(seeded, { credits: 80.5 }));
  await addLedgerEntry(db, {
    workspaceId,
    delta: 5,
    reason: "adjustment",
    periodStart: november,
    note: "Outage on the 9th",
  });
  // Next month's use and another workspace's use are not November's.
  await recordUsage(db, awake(seeded, { credits: 7, periodStart: december }));
  await recordUsage(db, awake(other, { credits: 9 }));

  expect(await ledgerBalance(db, { workspaceId, periodStart: november })).toEqual({
    granted: 100,
    used: 110.75,
    balance: -5.75,
  });
  expect(await ledgerBalance(db, { workspaceId, periodStart: december })).toEqual({
    granted: 0,
    used: 7,
    balance: -7,
  });
});

test("a workspace with no entries stands at zero", async () => {
  const seeded = await seedDesign(db);
  expect(
    await ledgerBalance(db, { workspaceId: seeded.workspace.id, periodStart: november }),
  ).toEqual({ granted: 0, used: 0, balance: 0 });
});

test("the ledger refuses entries that make no sense", async () => {
  const seeded = await seedDesign(db);
  const entry = { workspaceId: seeded.workspace.id, periodStart: november };

  await expect(addLedgerEntry(db, { ...entry, delta: -100, reason: "grant" })).rejects.toThrow();
  await expect(addLedgerEntry(db, { ...entry, delta: 0, reason: "adjustment" })).rejects.toThrow();
  // Use is spent through `recordUsage`, tied to its event.
  await expect(
    addLedgerEntry(db, { ...entry, delta: -1, reason: "use" as never }),
  ).rejects.toThrow();
});

test("a runner's turns are recorded per model, once, on the owner's plan", async () => {
  const { design, user, workspace } = await seedDesign(db);
  const other = await seedDesign(db);
  const model = (name: string, input: number) => ({
    model: name,
    inputTokens: input,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    costMicrousd: 1_500,
  });
  const turn = {
    id: "8f0c2b1e-0000-4000-8000-000000000001",
    at: november,
    models: [model("claude-opus-5-5", 10), model("claude-haiku-5-5", 3)],
  };

  expect(await recordTurnUsage(db, { designId: design.id, turns: [turn] })).toBe(1);
  expect(
    await recordTurnUsage(db, {
      designId: design.id,
      turns: [turn, { id: "8f0c2b1e-0000-4000-8000-000000000002", at: december, models: [] }],
    }),
  ).toBe(0);
  // Another design's turn of the same id is its own.
  expect(await recordTurnUsage(db, { designId: other.design.id, turns: [turn] })).toBe(1);

  const rows = await db.select().from(usageEvents).where(eq(usageEvents.designId, design.id));
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.model === "claude-opus-5-5")).toMatchObject({
    workspaceId: workspace.id,
    userId: user.id,
    kind: "model",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    costMicrousd: 1_500,
    credits: 0,
    payer: "own_plan",
    rateCardVersion: 1,
    occurredAt: november,
  });
  expect(await ledgerOf(workspace.id)).toEqual([]);
});

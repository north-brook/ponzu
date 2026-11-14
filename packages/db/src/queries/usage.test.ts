import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { creditLedger, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { addLedgerEntry, adjustCredits, recordTurnUsage } from "./usage.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const november = new Date("2026-11-01T00:00:00Z");
const december = new Date("2026-12-01T00:00:00Z");

const ledgerOf = (workspaceId: string) =>
  db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));

test("a member's allowance is granted once a period", async () => {
  const seeded = await seedCanvas(db);
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

  const grants = (periodStart: Date) =>
    ledgerOf(seeded.workspace.id).then((rows) =>
      rows.filter((row) => row.periodStart.getTime() === periodStart.getTime()),
    );
  expect((await grants(november)).map((row) => row.delta)).toEqual([100, 100]);
  expect((await grants(december)).map((row) => row.delta)).toEqual([100]);
});

test("an adjustment is a whole number of credits with a note, either way", async () => {
  const seeded = await seedCanvas(db);
  const workspaceId = seeded.workspace.id;

  await adjustCredits(db, { workspaceId, periodStart: november, credits: 25, note: "Outage" });
  await adjustCredits(db, {
    workspaceId,
    periodStart: november,
    credits: -5,
    note: " A correction ",
  });

  expect(
    (await ledgerOf(workspaceId)).map(({ delta, reason, note, userId }) => ({
      delta,
      reason,
      note,
      userId,
    })),
  ).toEqual([
    { delta: 25, reason: "adjustment", note: "Outage", userId: null },
    { delta: -5, reason: "adjustment", note: "A correction", userId: null },
  ]);
  for (const credits of [0, 1.5, Number.NaN]) {
    await expect(
      adjustCredits(db, { workspaceId, periodStart: november, credits, note: "x" }),
    ).rejects.toThrow("whole number");
  }
  await expect(
    adjustCredits(db, { workspaceId, periodStart: november, credits: 3, note: "  " }),
  ).rejects.toThrow("note");
  expect(await ledgerOf(workspaceId)).toHaveLength(2);
});

test("the ledger refuses entries that make no sense", async () => {
  const seeded = await seedCanvas(db);
  const entry = { workspaceId: seeded.workspace.id, periodStart: november };

  await expect(addLedgerEntry(db, { ...entry, delta: -100, reason: "grant" })).rejects.toThrow();
  await expect(addLedgerEntry(db, { ...entry, delta: 0, reason: "adjustment" })).rejects.toThrow();
  // Use is never a ledger row: usage_events is the record of it.
  await expect(
    addLedgerEntry(db, { ...entry, delta: -1, reason: "use" as never }),
  ).rejects.toThrow();
});

test("a runner's turns are recorded per model, once, on the owner's plan", async () => {
  const { canvas, user, workspace } = await seedCanvas(db);
  const other = await seedCanvas(db);
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

  expect(await recordTurnUsage(db, { canvasId: canvas.id, turns: [turn] })).toBe(1);
  expect(
    await recordTurnUsage(db, {
      canvasId: canvas.id,
      turns: [turn, { id: "8f0c2b1e-0000-4000-8000-000000000002", at: december, models: [] }],
    }),
  ).toBe(0);
  // Another canvas's turn of the same id is its own.
  expect(await recordTurnUsage(db, { canvasId: other.canvas.id, turns: [turn] })).toBe(1);

  const rows = await db.select().from(usageEvents).where(eq(usageEvents.canvasId, canvas.id));
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

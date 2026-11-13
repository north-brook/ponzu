// The meter's cuts (`cutAwake`, docs/cloud.md "Billing"), on PGlite: a long awake stretch metered
// in pieces, each a usage event dated when its piece began, adding up to the stretch exactly.
// PGlite is one connection, so "at once" here is two statements taking turns; races.live.test.ts
// runs the same race on a real Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { seedCanvas } from "../fixtures.ts";
import { usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { appendEvent } from "./events.ts";
import {
  beginSandbox,
  cutAwake,
  getSandbox,
  listAwakeToMeter,
  moveSandbox,
  type SandboxRow,
} from "./sandboxes.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const HOUR = 3600;
/** Seconds after 22:00 UTC on 2026-11-30, two hours before a December period starts. */
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 30, 22) + seconds * 1000);
const usageOf = (canvasId: string) =>
  db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.canvasId, canvasId))
    .orderBy(asc(usageEvents.occurredAt));
const ROOMY = { perWorkspace: 100, perOwner: 100 };

/** A canvas whose sandbox woke at `woke`, put down to its seeded person. */
async function awakeCanvas(woke = at(0)) {
  const seeded = await seedCanvas(db);
  const { canvas, user } = seeded;
  await appendEvent(db, {
    canvasId: canvas.id,
    kind: "message",
    priority: "now",
    userId: user.id,
    payload: { text: "Go" },
  });
  const claim = await beginSandbox(db, { canvasId: canvas.id, now: woke, by: "w", limits: ROOMY });
  if (!claim || "full" in claim) throw new Error("no sandbox");
  const awake = await moveSandbox(db, {
    canvasId: canvas.id,
    from: ["waking"],
    to: "awake",
    now: woke,
    by: "w",
  });
  return { ...seeded, sandbox: awake as SandboxRow };
}

const sleep = (canvasId: string, now: Date) =>
  moveSandbox(db, { canvasId, from: ["awake"], to: "asleep", now });

describe("cutAwake", () => {
  test("a stretch across a period end becomes two events, each dated in its period", async () => {
    const { canvas, user, workspace } = await awakeCanvas(at(0));
    const boundary = at(2 * HOUR);

    expect(await cutAwake(db, { canvasId: canvas.id, at: boundary, observedSince: at(0) })).toBe(
      true,
    );
    // Still awake, since when it woke, and metered on from the boundary.
    expect(await getSandbox(db, canvas.id)).toMatchObject({
      state: "awake",
      stateAt: at(0),
      awakeSince: boundary,
    });
    await sleep(canvas.id, at(3 * HOUR));

    expect(
      (await usageOf(canvas.id)).map(({ id, seconds, occurredAt, userId, workspaceId, payer }) => ({
        id,
        seconds,
        occurredAt,
        userId,
        workspaceId,
        payer,
      })),
    ).toEqual([
      {
        id: `${canvas.id}/${at(0).getTime()}`,
        seconds: 2 * HOUR,
        occurredAt: at(0),
        userId: user.id,
        workspaceId: workspace.id,
        payer: "ponzu",
      },
      {
        id: `${canvas.id}/${boundary.getTime()}`,
        seconds: HOUR,
        occurredAt: boundary,
        userId: user.id,
        workspaceId: workspace.id,
        payer: "ponzu",
      },
    ]);
  });

  test("an hourly cut, then another, then a sleep add up to the whole stretch to the second", async () => {
    const { canvas } = await awakeCanvas(at(0));
    expect(await cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(0) })).toBe(
      true,
    );
    expect(
      await cutAwake(db, { canvasId: canvas.id, at: at(2 * HOUR + 7), observedSince: at(HOUR) }),
    ).toBe(true);
    await sleep(canvas.id, at(2 * HOUR + 7 + 1234));

    const events = await usageOf(canvas.id);
    expect(events.map((event) => event.seconds)).toEqual([HOUR, HOUR + 7, 1234]);
    expect(events.reduce((sum, event) => sum + event.seconds!, 0)).toBe(2 * HOUR + 7 + 1234);
  });

  test("of two cuts of one stretch at once, one cuts and the other does nothing", async () => {
    const { canvas } = await awakeCanvas(at(0));
    const results = await Promise.all([
      cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(0) }),
      cutAwake(db, { canvasId: canvas.id, at: at(HOUR + 30), observedSince: at(0) }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await usageOf(canvas.id)).toHaveLength(1);
    await sleep(canvas.id, at(2 * HOUR));
    // Whichever won, nothing is lost and nothing counted twice.
    const total = (await usageOf(canvas.id)).reduce((sum, event) => sum + event.seconds!, 0);
    expect(total).toBe(2 * HOUR);
  });

  test("a cut of a stretch already cut, slept or never awake does nothing", async () => {
    const { canvas } = await awakeCanvas(at(0));
    await cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(0) });
    // The same cut again (a sweep run twice) finds the stretch moved on.
    expect(await cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(0) })).toBe(
      false,
    );
    // Never at or before where the stretch begins.
    expect(await cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(HOUR) })).toBe(
      false,
    );
    await sleep(canvas.id, at(2 * HOUR));
    expect(
      await cutAwake(db, { canvasId: canvas.id, at: at(3 * HOUR), observedSince: at(HOUR) }),
    ).toBe(false);
    expect((await usageOf(canvas.id)).map((event) => event.seconds)).toEqual([HOUR, HOUR]);
  });

  test("a cut and a sleep at once meter the stretch once, to the second", async () => {
    const { canvas } = await awakeCanvas(at(0));
    // On a real Postgres the sleep may wait on the row while the cut commits; it then holds to
    // the stretch it read, does nothing, and goes again from the cut (races.live.test.ts).
    const [cut, slept] = await Promise.all([
      cutAwake(db, { canvasId: canvas.id, at: at(HOUR), observedSince: at(0) }),
      sleep(canvas.id, at(HOUR + 600)),
    ]);
    expect(slept).toMatchObject({ state: "asleep", awakeSince: null });
    const events = await usageOf(canvas.id);
    const total = events.reduce((sum, event) => sum + event.seconds!, 0);
    expect(total).toBe(HOUR + 600);
    expect(events).toHaveLength(cut ? 2 : 1);
  });

  test("the meter lists every awake sandbox with its workspace's anchor", async () => {
    const { canvas, workspace } = await awakeCanvas(at(0));
    const listed = (await listAwakeToMeter(db)).find((row) => row.canvasId === canvas.id);
    expect(listed).toEqual({
      canvasId: canvas.id,
      awakeSince: at(0),
      periodAnchor: workspace.billingPeriodAnchor,
    });
    await sleep(canvas.id, at(60));
    expect((await listAwakeToMeter(db)).some((row) => row.canvasId === canvas.id)).toBe(false);
  });
});

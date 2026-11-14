// What Plan and usage reads of a period (`readWorkspaceUsage`), on PGlite: the adjustments
// support makes, the members a closed period counts, and the live stretch kept inside a past
// period's end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { memberships } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { appendEvent } from "./events.ts";
import { beginSandbox, moveSandbox } from "./sandboxes.ts";
import { adjustCredits } from "./usage.ts";
import { readWorkspaceUsage } from "./workspace-usage.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const november = new Date("2026-11-09T00:00:00Z");
const december = new Date("2026-12-09T00:00:00Z");
const january = new Date("2027-01-09T00:00:00Z");

const readPeriod = (
  workspaceId: string,
  viewerId: string,
  start: Date,
  end: Date,
  now: Date,
  membersBefore?: Date,
) =>
  readWorkspaceUsage(db, {
    workspaceId,
    viewerId,
    start,
    end,
    now,
    ...(membersBefore ? { membersBefore } : {}),
  });

describe("readWorkspaceUsage", () => {
  test("adds up the period's adjustments, plus and minus, and no other period's", async () => {
    const { workspace, user } = await seedCanvas(db);
    const read = () =>
      readPeriod(workspace.id, user.id, november, december, new Date("2026-11-20T00:00:00Z"));
    expect((await read())!.adjustedCredits).toBe(0);

    const adjust = (credits: number, periodStart = november) =>
      adjustCredits(db, { workspaceId: workspace.id, periodStart, credits, note: "test" });
    await adjust(40);
    await adjust(-15);
    await adjust(500, december);

    expect((await read())!.adjustedCredits).toBe(25);
  });

  test("with membersBefore, counts only members who joined before then", async () => {
    const { workspace, user } = await seedCanvas(db);
    const early = await seedUser(db, "early");
    const late = await seedUser(db, "late");
    for (const person of [user, early, late]) {
      await upsertMembership(db, { workspaceId: workspace.id, userId: person.id, role: "member" });
    }
    const joined = async (userId: string, when: string) =>
      db
        .update(memberships)
        .set({ createdAt: sql`${when}::timestamptz` })
        .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, userId)));
    await joined(user.id, "2026-10-01T00:00:00Z");
    await joined(early.id, "2026-11-20T00:00:00Z");
    await joined(late.id, "2026-12-10T00:00:00Z");

    const now = new Date("2026-12-10T12:00:00Z");
    const all = await readPeriod(workspace.id, user.id, november, december, now);
    const closed = await readPeriod(workspace.id, user.id, november, december, now, december);
    const ids = (r: typeof all) => r!.people.map((person) => person.id).toSorted();

    expect(ids(all)).toEqual([user.id, early.id, late.id].toSorted());
    expect(ids(closed)).toEqual([user.id, early.id].toSorted());
  });

  test("a live stretch counts no further than the end of a past period", async () => {
    const { canvas, workspace, user } = await seedCanvas(db);
    await appendEvent(db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      userId: user.id,
      payload: { text: "Go" },
    });
    const woke = new Date("2026-12-08T22:00:00Z");
    const limits = { perWorkspace: 100, perOwner: 100 };
    await beginSandbox(db, { canvasId: canvas.id, now: woke, by: "w", limits });
    await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "awake",
      now: woke,
      by: "w",
    });
    const now = new Date("2026-12-09T03:00:00Z");
    const seconds = async (start: Date, end: Date) =>
      (await readPeriod(workspace.id, user.id, start, end, now))!.rows.reduce(
        (sum, row) => sum + row.seconds,
        0,
      );

    // November's period, read after it ended: two hours, up to its end.
    expect(await seconds(november, december)).toBe(2 * 3600);
    // The period running now: a stretch counts in the period it began in, as on main, so none.
    expect(await seconds(december, january)).toBe(0);
  });

  test("the current period's live stretch counts up to now, as before", async () => {
    const { canvas, workspace, user } = await seedCanvas(db);
    const woke = new Date("2026-11-20T10:00:00Z");
    const limits = { perWorkspace: 100, perOwner: 100 };
    await beginSandbox(db, { canvasId: canvas.id, now: woke, by: "w", limits });
    await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "awake",
      now: woke,
      by: "w",
    });
    const read = await readPeriod(
      workspace.id,
      user.id,
      november,
      december,
      new Date("2026-11-20T10:30:00Z"),
    );
    expect(read!.rows.map((row) => row.seconds)).toEqual([1800]);
  });
});

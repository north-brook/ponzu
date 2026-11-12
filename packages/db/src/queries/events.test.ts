import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { seedCanvas } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { canvases, canvasRunners, events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  appendEvent,
  claimEvents,
  findStops,
  lapseEvents,
  markEventsDelivered,
  personOf,
} from "./events.ts";
import { runnerHeardSince, takeRunnerLease } from "./runners.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const say = (db: Db, canvasId: string, text: string, priority: "now" | "next" | "later" = "now") =>
  appendEvent(db, { canvasId, kind: "message", priority, payload: { text } });

const texts = (claimed: { payload: unknown }[]) =>
  claimed.map((event) => (event.payload as { text: string }).text);

const ids = (claimed: { id: string }[]) => claimed.map((event) => event.id);

/**
 * A runner starting for the canvas: it takes the lease, then claims, each time under a new claim
 * id unless one is given, and acknowledges, as that runner.
 */
async function start(canvasId: string) {
  const { runnerId } = await takeRunnerLease(db, { canvasId, now: new Date() });
  return {
    runnerId,
    claim: async (limit?: number, claimId = newId("clm")) =>
      (await claimEvents(db, { canvasId, runnerId, claimId, limit }))!.events,
    ack: (ids: string[], claudeSessionId: string | null = null) =>
      markEventsDelivered(db, { canvasId, runnerId, ids, claudeSessionId }),
  };
}

test("an appended event waits, undelivered", async () => {
  const { canvas, user } = await seedCanvas(db);

  const event = await appendEvent(db, {
    canvasId: canvas.id,
    kind: "comment",
    priority: "next",
    payload: { threadId: "th_1" },
    userId: user.id,
  });

  expect(event.id).toMatch(/^evt_/);
  expect(event).toMatchObject({
    kind: "comment",
    priority: "next",
    payload: { threadId: "th_1" },
    userId: user.id,
    claimedAt: null,
    claimedBy: null,
    deliveredAt: null,
  });
});

test("a claim hands the runner the waiting events in order, once, with who is behind each", async () => {
  const { canvas, user } = await seedCanvas(db);
  await appendEvent(db, {
    canvasId: canvas.id,
    kind: "message",
    priority: "now",
    payload: { text: "first" },
    userId: user.id,
  });
  await say(db, canvas.id, "second", "later");
  await say(db, canvas.id, "third", "next");
  const runner = await start(canvas.id);

  const claimed = await runner.claim();

  expect(texts(claimed)).toEqual(["first", "second", "third"]);
  expect(claimed[0]).toMatchObject({
    claimedBy: runner.runnerId,
    from: { id: user.id, name: user.name, login: user.githubLogin },
  });
  expect(claimed[0]!.claimedAt).toBeInstanceOf(Date);
  expect(claimed[1]!.from).toBeNull();
  expect(await runner.claim()).toEqual([]);
});

test("a claim is one canvas's, and respects its limit", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  await say(db, one.canvas.id, "a");
  await say(db, one.canvas.id, "b");
  await say(db, other.canvas.id, "elsewhere");
  const runner = await start(one.canvas.id);

  expect(texts(await runner.claim(1))).toEqual(["a"]);
  expect(texts(await runner.claim())).toEqual(["b"]);
  // A runner of one canvas claims nothing of another's, whatever id it names.
  const elsewhere = await claimEvents(db, {
    canvasId: other.canvas.id,
    runnerId: runner.runnerId,
    claimId: newId("clm"),
  });
  expect(elsewhere!.events).toEqual([]);
  expect(texts(await (await start(other.canvas.id)).claim())).toEqual(["elsewhere"]);
});

test("a claim answers the canvas's head, and a canvas that is not there answers null", async () => {
  const { canvas } = await seedCanvas(db);
  const { runnerId } = await start(canvas.id);

  const claimed = await claimEvents(db, { canvasId: canvas.id, runnerId, claimId: newId("clm") });

  expect(claimed).toEqual({ events: [], seq: canvas.seq, pullRequest: null });
  expect(
    await claimEvents(db, { canvasId: "cnv_missing", runnerId, claimId: newId("clm") }),
  ).toBeNull();
});

test("a claim says the canvas's pull request as its row has it, for the agent's next turn", async () => {
  const { canvas } = await seedCanvas(db);
  const { runnerId } = await start(canvas.id);
  await db
    .update(canvases)
    .set({ prNumber: 12, prState: "draft" })
    .where(eq(canvases.id, canvas.id));

  const claimed = await claimEvents(db, { canvasId: canvas.id, runnerId, claimId: newId("clm") });

  expect(claimed?.pullRequest).toEqual({ number: 12, state: "draft" });
});

test("a claim sent again hands out again what it handed out, and nothing new", async () => {
  const { canvas } = await seedCanvas(db);
  for (const text of ["a", "b", "c"]) await say(db, canvas.id, text);
  const runner = await start(canvas.id);
  const claimId = newId("clm");
  expect(texts(await runner.claim(2, claimId))).toEqual(["a", "b"]);

  // Its answer was lost. Something new arrives before the runner sends it again.
  await say(db, canvas.id, "d");
  expect(texts(await runner.claim(2, claimId))).toEqual(["a", "b"]);

  // Once the runner has them, a new claim goes on from there.
  expect(texts(await runner.claim(undefined))).toEqual(["c", "d"]);
  expect(await runner.ack(ids(await runner.claim(2, claimId)))).toBe(2);
  expect(await runner.claim()).toEqual([]);
});

test("two claims at once never hand out the same event", async () => {
  const { canvas } = await seedCanvas(db);
  for (const text of ["a", "b", "c", "d"]) await say(db, canvas.id, text);
  const runner = await start(canvas.id);

  const [one, two] = await Promise.all([runner.claim(), runner.claim()]);

  expect([...texts(one), ...texts(two)].sort()).toEqual(["a", "b", "c", "d"]);
});

test("what a runner took and never delivered is the next runner's, at once", async () => {
  const { canvas } = await seedCanvas(db);
  await say(db, canvas.id, "lost with the runner");
  const first = await start(canvas.id);
  expect(texts(await first.claim())).toEqual(["lost with the runner"]);

  const second = await start(canvas.id);
  await say(db, canvas.id, "new");

  expect(texts(await second.claim())).toEqual(["lost with the runner", "new"]);
  expect(await second.claim()).toEqual([]);
});

test("a runner whose lease was taken is handed nothing", async () => {
  const { canvas } = await seedCanvas(db);
  const old = await start(canvas.id);
  await start(canvas.id);
  await say(db, canvas.id, "for the new one");

  expect(await old.claim()).toEqual([]);
  const [row] = await db.select().from(events).where(eq(events.canvasId, canvas.id));
  expect(row!.claimedBy).toBeNull();
});

test("delivered events are never handed out again, to this runner or the next", async () => {
  const { canvas } = await seedCanvas(db);
  await say(db, canvas.id, "a");
  await say(db, canvas.id, "b");
  const runner = await start(canvas.id);
  const claimed = await runner.claim();

  const delivered = await runner.ack(ids(claimed));

  expect(delivered).toBe(2);
  expect(await runner.ack(ids(claimed))).toBe(0);
  expect(await runner.ack([])).toBe(0);
  expect(await (await start(canvas.id)).claim()).toEqual([]);
});

test("a runner acknowledges only what it claimed, and nothing once its lease is taken", async () => {
  const { canvas } = await seedCanvas(db);
  await say(db, canvas.id, "first");
  const old = await start(canvas.id);
  const held = await old.claim();
  await say(db, canvas.id, "second");
  const next = await start(canvas.id);
  const taken = await next.claim();
  expect(texts(taken)).toEqual(["first", "second"]);
  const unclaimed = await say(db, canvas.id, "not yet claimed");

  // The old runner's late ack, of what it held and the new one now holds.
  expect(await old.ack([...ids(held), ...ids(taken)], "sess-old")).toBe(0);
  // The new one's, of an event it was never handed.
  expect(await next.ack([unclaimed.id], "sess-new")).toBe(0);

  const rows = await db.select().from(events).where(eq(events.canvasId, canvas.id));
  expect(rows.map((row) => row.deliveredAt)).toEqual([null, null, null]);
  const [lease] = await db
    .select()
    .from(canvasRunners)
    .where(eq(canvasRunners.canvasId, canvas.id));
  expect(lease!.claudeSessionId).toBe("sess-new");
  expect(await next.ack(ids(taken))).toBe(2);
});

test("acknowledging one claim leaves what another claim holds", async () => {
  const { canvas } = await seedCanvas(db);
  for (const text of ["a", "b", "c"]) await say(db, canvas.id, text);
  const runner = await start(canvas.id);
  const first = await runner.claim(2);
  const second = await runner.claim();
  expect(texts(second)).toEqual(["c"]);

  // The later claim finishes first. Its events are after the other's in the feed.
  expect(await runner.ack(ids(second))).toBe(1);

  const rows = await db.select().from(events).where(eq(events.canvasId, canvas.id));
  const delivered = Object.fromEntries(rows.map((row) => [row.id, row.deliveredAt !== null]));
  expect(delivered).toEqual({
    [first[0]!.id]: false,
    [first[1]!.id]: false,
    [second[0]!.id]: true,
  });
});

test("marking delivered is one canvas's", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  await say(db, one.canvas.id, "a");
  const runner = await start(one.canvas.id);
  const claimed = await runner.claim();
  const elsewhere = { canvasId: other.canvas.id, runnerId: runner.runnerId, ids: ids(claimed) };

  expect(await markEventsDelivered(db, elsewhere)).toBe(0);
  expect(await runner.ack(ids(claimed))).toBe(1);
});

test("an ack keeps the Claude session its events went into, and a null one keeps the last", async () => {
  const { canvas } = await seedCanvas(db);
  await say(db, canvas.id, "a");
  const runner = await start(canvas.id);
  const claimed = await runner.claim();
  const session = async () =>
    (await db.select().from(canvasRunners).where(eq(canvasRunners.canvasId, canvas.id)))[0]!
      .claudeSessionId;

  await runner.ack(ids(claimed), "sess-1");
  expect(await session()).toBe("sess-1");

  await runner.ack([], null);
  expect(await session()).toBe("sess-1");
  await runner.ack([], "sess-2");
  expect(await session()).toBe("sess-2");
});

test("a canvas's stops are found with who stopped the run, and nothing else is", async () => {
  const { canvas, user } = await seedCanvas(db);
  const other = await seedCanvas(db);
  const stop = await appendEvent(db, {
    canvasId: canvas.id,
    kind: "stop",
    priority: "now",
    payload: {},
    userId: user.id,
  });
  const message = await say(db, canvas.id, "not a stop");
  const elsewhere = await appendEvent(db, {
    canvasId: other.canvas.id,
    kind: "stop",
    priority: "now",
    payload: {},
  });

  const found = await findStops(db, {
    canvasId: canvas.id,
    ids: [stop.id, message.id, elsewhere.id],
  });

  expect(found).toEqual([{ id: stop.id, from: personOf(user) }]);
  expect(await findStops(db, { canvasId: canvas.id, ids: [] })).toEqual([]);
});

test("text Postgres cannot store is replaced in the payload, not refused", async () => {
  const { canvas } = await seedCanvas(db);

  const event = await say(db, canvas.id, "cut \ud83d here\u0000");

  expect(event.payload).toEqual({ text: "cut � here�" });
});

test("a lapsed event goes in again once, as a copy any runner claims as new; a copy is not copied", async () => {
  const { canvas } = await seedCanvas(db);
  const message = await say(db, canvas.id, "use hugeicons");
  const first = await start(canvas.id);
  await first.claim();
  await first.ack([message.id]);
  const now = new Date();

  // Two sweeps at once: one lapses it.
  const [a, b] = await Promise.all([
    lapseEvents(db, { canvasId: canvas.id, ids: [message.id], now }),
    lapseEvents(db, { canvasId: canvas.id, ids: [message.id], now }),
  ]);
  const lapsed = [...a, ...b];
  expect(lapsed).toHaveLength(1);
  expect(lapsed[0]).toMatchObject({ id: message.id, kind: "message", retryOf: null });
  const copyId = lapsed[0]!.copy!;
  expect(copyId).toMatch(/^evt_/);

  // The runner that took the original claims the copy: it has never been handed it.
  const [copy] = await first.claim();
  expect(copy).toMatchObject({
    id: copyId,
    kind: "message",
    priority: "now",
    payload: { text: "use hugeicons", retryOf: message.id },
  });

  // Not delivered, a copy cannot lapse; delivered and lapsed, it is not copied again.
  expect(await lapseEvents(db, { canvasId: canvas.id, ids: [copyId], now })).toEqual([]);
  await first.ack([copyId]);
  expect(await lapseEvents(db, { canvasId: canvas.id, ids: [copyId], now })).toEqual([
    { id: copyId, kind: "message", retryOf: message.id, copy: null },
  ]);
  expect(await first.claim()).toEqual([]);
});

test("a runner heard since a moment is one that reported, claimed or acknowledged after it", async () => {
  const { canvas } = await seedCanvas(db);
  const before = new Date(Date.now() - 60_000);
  const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: before });
  const thaw = new Date();
  expect(await runnerHeardSince(db, { canvasId: canvas.id, since: thaw })).toBe(false);
  const message = await say(db, canvas.id, "hi");
  const later = new Date(thaw.getTime() + 1_000);
  await claimEvents(db, { canvasId: canvas.id, runnerId, claimId: newId("clm"), now: later });
  expect(await runnerHeardSince(db, { canvasId: canvas.id, since: thaw })).toBe(true);
  expect(
    await runnerHeardSince(db, { canvasId: canvas.id, since: new Date(later.getTime() + 1) }),
  ).toBe(false);
  await markEventsDelivered(db, {
    canvasId: canvas.id,
    runnerId,
    ids: [message.id],
    now: new Date(later.getTime() + 5_000),
  });
  expect(
    await runnerHeardSince(db, { canvasId: canvas.id, since: new Date(later.getTime() + 1) }),
  ).toBe(true);
});

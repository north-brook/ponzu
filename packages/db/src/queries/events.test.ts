import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { seedDesign } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { designRunners, designs, events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { appendEvent, claimEvents, findStops, markEventsDelivered, personOf } from "./events.ts";
import { takeRunnerLease } from "./runners.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const say = (db: Db, designId: string, text: string, priority: "now" | "next" | "later" = "now") =>
  appendEvent(db, { designId, kind: "message", priority, payload: { text } });

const texts = (claimed: { payload: unknown }[]) =>
  claimed.map((event) => (event.payload as { text: string }).text);

const ids = (claimed: { id: string }[]) => claimed.map((event) => event.id);

/**
 * A runner starting for the design: it takes the lease, then claims, each time under a new claim
 * id unless one is given, and acknowledges, as that runner.
 */
async function start(designId: string) {
  const { runnerId } = await takeRunnerLease(db, { designId, now: new Date() });
  return {
    runnerId,
    claim: async (limit?: number, claimId = newId("clm")) =>
      (await claimEvents(db, { designId, runnerId, claimId, limit }))!.events,
    ack: (ids: string[], claudeSessionId: string | null = null) =>
      markEventsDelivered(db, { designId, runnerId, ids, claudeSessionId }),
  };
}

test("an appended event waits, undelivered", async () => {
  const { design, user } = await seedDesign(db);

  const event = await appendEvent(db, {
    designId: design.id,
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
  const { design, user } = await seedDesign(db);
  await appendEvent(db, {
    designId: design.id,
    kind: "message",
    priority: "now",
    payload: { text: "first" },
    userId: user.id,
  });
  await say(db, design.id, "second", "later");
  await say(db, design.id, "third", "next");
  const runner = await start(design.id);

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

test("a claim is one design's, and respects its limit", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await say(db, one.design.id, "a");
  await say(db, one.design.id, "b");
  await say(db, other.design.id, "elsewhere");
  const runner = await start(one.design.id);

  expect(texts(await runner.claim(1))).toEqual(["a"]);
  expect(texts(await runner.claim())).toEqual(["b"]);
  // A runner of one design claims nothing of another's, whatever id it names.
  const elsewhere = await claimEvents(db, {
    designId: other.design.id,
    runnerId: runner.runnerId,
    claimId: newId("clm"),
  });
  expect(elsewhere!.events).toEqual([]);
  expect(texts(await (await start(other.design.id)).claim())).toEqual(["elsewhere"]);
});

test("a claim answers the design's head, and a design that is not there answers null", async () => {
  const { design } = await seedDesign(db);
  const { runnerId } = await start(design.id);

  const claimed = await claimEvents(db, { designId: design.id, runnerId, claimId: newId("clm") });

  expect(claimed).toEqual({ events: [], seq: design.seq, pullRequest: null });
  expect(
    await claimEvents(db, { designId: "des_missing", runnerId, claimId: newId("clm") }),
  ).toBeNull();
});

test("a claim says the design's pull request as its row has it, for the agent's next turn", async () => {
  const { design } = await seedDesign(db);
  const { runnerId } = await start(design.id);
  await db.update(designs).set({ prNumber: 12, prState: "draft" }).where(eq(designs.id, design.id));

  const claimed = await claimEvents(db, { designId: design.id, runnerId, claimId: newId("clm") });

  expect(claimed?.pullRequest).toEqual({ number: 12, state: "draft" });
});

test("a claim sent again hands out again what it handed out, and nothing new", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["a", "b", "c"]) await say(db, design.id, text);
  const runner = await start(design.id);
  const claimId = newId("clm");
  expect(texts(await runner.claim(2, claimId))).toEqual(["a", "b"]);

  // Its answer was lost. Something new arrives before the runner sends it again.
  await say(db, design.id, "d");
  expect(texts(await runner.claim(2, claimId))).toEqual(["a", "b"]);

  // Once the runner has them, a new claim goes on from there.
  expect(texts(await runner.claim(undefined))).toEqual(["c", "d"]);
  expect(await runner.ack(ids(await runner.claim(2, claimId)))).toBe(2);
  expect(await runner.claim()).toEqual([]);
});

test("two claims at once never hand out the same event", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["a", "b", "c", "d"]) await say(db, design.id, text);
  const runner = await start(design.id);

  const [one, two] = await Promise.all([runner.claim(), runner.claim()]);

  expect([...texts(one), ...texts(two)].sort()).toEqual(["a", "b", "c", "d"]);
});

test("what a runner took and never delivered is the next runner's, at once", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "lost with the runner");
  const first = await start(design.id);
  expect(texts(await first.claim())).toEqual(["lost with the runner"]);

  const second = await start(design.id);
  await say(db, design.id, "new");

  expect(texts(await second.claim())).toEqual(["lost with the runner", "new"]);
  expect(await second.claim()).toEqual([]);
});

test("a runner whose lease was taken is handed nothing", async () => {
  const { design } = await seedDesign(db);
  const old = await start(design.id);
  await start(design.id);
  await say(db, design.id, "for the new one");

  expect(await old.claim()).toEqual([]);
  const [row] = await db.select().from(events).where(eq(events.designId, design.id));
  expect(row!.claimedBy).toBeNull();
});

test("delivered events are never handed out again, to this runner or the next", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "a");
  await say(db, design.id, "b");
  const runner = await start(design.id);
  const claimed = await runner.claim();

  const delivered = await runner.ack(ids(claimed));

  expect(delivered).toBe(2);
  expect(await runner.ack(ids(claimed))).toBe(0);
  expect(await runner.ack([])).toBe(0);
  expect(await (await start(design.id)).claim()).toEqual([]);
});

test("a runner acknowledges only what it claimed, and nothing once its lease is taken", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "first");
  const old = await start(design.id);
  const held = await old.claim();
  await say(db, design.id, "second");
  const next = await start(design.id);
  const taken = await next.claim();
  expect(texts(taken)).toEqual(["first", "second"]);
  const unclaimed = await say(db, design.id, "not yet claimed");

  // The old runner's late ack, of what it held and the new one now holds.
  expect(await old.ack([...ids(held), ...ids(taken)], "sess-old")).toBe(0);
  // The new one's, of an event it was never handed.
  expect(await next.ack([unclaimed.id], "sess-new")).toBe(0);

  const rows = await db.select().from(events).where(eq(events.designId, design.id));
  expect(rows.map((row) => row.deliveredAt)).toEqual([null, null, null]);
  const [lease] = await db
    .select()
    .from(designRunners)
    .where(eq(designRunners.designId, design.id));
  expect(lease!.claudeSessionId).toBe("sess-new");
  expect(await next.ack(ids(taken))).toBe(2);
});

test("acknowledging one claim leaves what another claim holds", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["a", "b", "c"]) await say(db, design.id, text);
  const runner = await start(design.id);
  const first = await runner.claim(2);
  const second = await runner.claim();
  expect(texts(second)).toEqual(["c"]);

  // The later claim finishes first. Its events are after the other's in the feed.
  expect(await runner.ack(ids(second))).toBe(1);

  const rows = await db.select().from(events).where(eq(events.designId, design.id));
  const delivered = Object.fromEntries(rows.map((row) => [row.id, row.deliveredAt !== null]));
  expect(delivered).toEqual({
    [first[0]!.id]: false,
    [first[1]!.id]: false,
    [second[0]!.id]: true,
  });
});

test("marking delivered is one design's", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await say(db, one.design.id, "a");
  const runner = await start(one.design.id);
  const claimed = await runner.claim();
  const elsewhere = { designId: other.design.id, runnerId: runner.runnerId, ids: ids(claimed) };

  expect(await markEventsDelivered(db, elsewhere)).toBe(0);
  expect(await runner.ack(ids(claimed))).toBe(1);
});

test("an ack keeps the Claude session its events went into, and a null one keeps the last", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "a");
  const runner = await start(design.id);
  const claimed = await runner.claim();
  const session = async () =>
    (await db.select().from(designRunners).where(eq(designRunners.designId, design.id)))[0]!
      .claudeSessionId;

  await runner.ack(ids(claimed), "sess-1");
  expect(await session()).toBe("sess-1");

  await runner.ack([], null);
  expect(await session()).toBe("sess-1");
  await runner.ack([], "sess-2");
  expect(await session()).toBe("sess-2");
});

test("a design's stops are found with who stopped the run, and nothing else is", async () => {
  const { design, user } = await seedDesign(db);
  const other = await seedDesign(db);
  const stop = await appendEvent(db, {
    designId: design.id,
    kind: "stop",
    priority: "now",
    payload: {},
    userId: user.id,
  });
  const message = await say(db, design.id, "not a stop");
  const elsewhere = await appendEvent(db, {
    designId: other.design.id,
    kind: "stop",
    priority: "now",
    payload: {},
  });

  const found = await findStops(db, {
    designId: design.id,
    ids: [stop.id, message.id, elsewhere.id],
  });

  expect(found).toEqual([{ id: stop.id, from: personOf(user) }]);
  expect(await findStops(db, { designId: design.id, ids: [] })).toEqual([]);
});

test("text Postgres cannot store is replaced in the payload, not refused", async () => {
  const { design } = await seedDesign(db);

  const event = await say(db, design.id, "cut \ud83d here\u0000");

  expect(event.payload).toEqual({ text: "cut � here�" });
});

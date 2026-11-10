import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { seedDesign } from "../fixtures.ts";
import { events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { appendEvent, claimEvents, markEventsDelivered } from "./events.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const say = (db: Db, designId: string, text: string, priority: "now" | "next" | "later" = "now") =>
  appendEvent(db, { designId, kind: "message", priority, payload: { text } });

const texts = (claimed: { payload: unknown }[]) =>
  claimed.map((event) => (event.payload as { text: string }).text);

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
    deliveredAt: null,
  });
});

test("a claim takes the waiting events in order, once", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "first");
  await say(db, design.id, "second", "later");
  await say(db, design.id, "third", "next");

  const claimed = await claimEvents(db, { designId: design.id });

  expect(texts(claimed)).toEqual(["first", "second", "third"]);
  expect(claimed[0]!.claimedAt).toBeInstanceOf(Date);
  expect(await claimEvents(db, { designId: design.id })).toEqual([]);
});

test("a claim is one design's, and respects its limit", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await say(db, one.design.id, "a");
  await say(db, one.design.id, "b");
  await say(db, other.design.id, "elsewhere");

  expect(texts(await claimEvents(db, { designId: one.design.id, limit: 1 }))).toEqual(["a"]);
  expect(texts(await claimEvents(db, { designId: one.design.id }))).toEqual(["b"]);
  expect(texts(await claimEvents(db, { designId: other.design.id }))).toEqual(["elsewhere"]);
});

test("two claims at once never hand out the same event", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["a", "b", "c", "d"]) await say(db, design.id, text);

  const [one, two] = await Promise.all([
    claimEvents(db, { designId: design.id }),
    claimEvents(db, { designId: design.id }),
  ]);

  expect([...texts(one), ...texts(two)].sort()).toEqual(["a", "b", "c", "d"]);
});

test("an event taken and never delivered is handed out again after a while", async () => {
  const { design } = await seedDesign(db);
  const event = await say(db, design.id, "lost with the runner");
  await claimEvents(db, { designId: design.id });
  expect(await claimEvents(db, { designId: design.id })).toEqual([]);

  await db
    .update(events)
    .set({ claimedAt: sql`now() - interval '2 minutes'` })
    .where(eq(events.id, event.id));

  expect(texts(await claimEvents(db, { designId: design.id }))).toEqual(["lost with the runner"]);
  expect(await claimEvents(db, { designId: design.id, retakeAfterSeconds: 600 })).toEqual([]);
});

test("delivered events are never handed out again", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "a");
  await say(db, design.id, "b");
  const claimed = await claimEvents(db, { designId: design.id });

  const delivered = await markEventsDelivered(db, {
    designId: design.id,
    throughSeq: claimed[1]!.seq,
  });

  expect(delivered).toBe(2);
  await db
    .update(events)
    .set({ claimedAt: sql`now() - interval '1 hour'` })
    .where(eq(events.designId, design.id));
  expect(await claimEvents(db, { designId: design.id })).toEqual([]);
  expect(await markEventsDelivered(db, { designId: design.id, throughSeq: claimed[1]!.seq })).toBe(
    0,
  );
});

test("marking delivered stops at the cursor and skips what was never taken", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "a");
  await say(db, design.id, "b");
  const [a, b] = await claimEvents(db, { designId: design.id });
  const late = await say(db, design.id, "arrived after the claim");

  // The cursor covers only `a`.
  expect(await markEventsDelivered(db, { designId: design.id, throughSeq: a!.seq })).toBe(1);
  // A cursor past everything still leaves the event no runner has taken.
  expect(await markEventsDelivered(db, { designId: design.id, throughSeq: late.seq })).toBe(1);

  const rows = await db.select().from(events).where(eq(events.designId, design.id));
  const state = Object.fromEntries(rows.map((row) => [row.id, row.deliveredAt !== null]));
  expect(state).toEqual({ [a!.id]: true, [b!.id]: true, [late.id]: false });
  expect(texts(await claimEvents(db, { designId: design.id }))).toEqual([
    "arrived after the claim",
  ]);
});

test("marking delivered is one design's", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await say(db, one.design.id, "a");
  const [claimed] = await claimEvents(db, { designId: one.design.id });

  expect(
    await markEventsDelivered(db, { designId: other.design.id, throughSeq: claimed!.seq }),
  ).toBe(0);
});

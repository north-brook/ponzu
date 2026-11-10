import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { seedDesign } from "../fixtures.ts";
import { events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { appendEvent, appendEvents, claimEvents, markEventsDelivered } from "./events.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const say = (db: Db, designId: string, text: string, priority: "now" | "next" | "later" = "now") =>
  appendEvent(db, { designId, kind: "message", priority, payload: { text } });

const texts = (claimed: { payload: unknown }[]) =>
  claimed.map((event) => (event.payload as { text: string }).text);

test("several events append in one go, in order, and are claimed in that order", async () => {
  const { design, user } = await seedDesign(db);
  const event = (text: string) => ({
    designId: design.id,
    kind: "edit" as const,
    priority: "later" as const,
    payload: { text: `${text}\u0000` },
    userId: user.id,
  });

  const appended = await appendEvents(db, [event("one"), event("two"), event("three")]);

  expect(texts(appended)).toEqual(["one�", "two�", "three�"]);
  expect(texts(await claimEvents(db, { designId: design.id }))).toEqual(texts(appended));
  expect(await appendEvents(db, [])).toEqual([]);
});

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

const ids = (claimed: { id: string }[]) => claimed.map((event) => event.id);

test("delivered events are never handed out again", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "a");
  await say(db, design.id, "b");
  const claimed = await claimEvents(db, { designId: design.id });

  const delivered = await markEventsDelivered(db, { designId: design.id, ids: ids(claimed) });

  expect(delivered).toBe(2);
  await db
    .update(events)
    .set({ claimedAt: sql`now() - interval '1 hour'` })
    .where(eq(events.designId, design.id));
  expect(await claimEvents(db, { designId: design.id })).toEqual([]);
  expect(await markEventsDelivered(db, { designId: design.id, ids: ids(claimed) })).toBe(0);
  expect(await markEventsDelivered(db, { designId: design.id, ids: [] })).toBe(0);
});

test("a runner that restarts and acknowledges its new claim does not write off the old one", async () => {
  const { design } = await seedDesign(db);
  await say(db, design.id, "one");
  await say(db, design.id, "two");
  // The runner takes both and dies before it has taken either in.
  expect(texts(await claimEvents(db, { designId: design.id }))).toEqual(["one", "two"]);

  await say(db, design.id, "three");
  // It comes back inside the retake window, so it is handed only what arrived since.
  const second = await claimEvents(db, { designId: design.id });
  expect(texts(second)).toEqual(["three"]);
  expect(await markEventsDelivered(db, { designId: design.id, ids: ids(second) })).toBe(1);

  // The two it never took in are still waiting, and come round again.
  expect(texts(await claimEvents(db, { designId: design.id, retakeAfterSeconds: 0 }))).toEqual([
    "one",
    "two",
  ]);
});

test("acknowledging one claim leaves what another claim holds", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["a", "b", "c"]) await say(db, design.id, text);
  const first = await claimEvents(db, { designId: design.id, limit: 2 });
  const second = await claimEvents(db, { designId: design.id });
  expect(texts(second)).toEqual(["c"]);

  // The later claim finishes first. Its events are after the other's in the feed.
  expect(await markEventsDelivered(db, { designId: design.id, ids: ids(second) })).toBe(1);

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
  const claimed = await claimEvents(db, { designId: one.design.id });

  expect(await markEventsDelivered(db, { designId: other.design.id, ids: ids(claimed) })).toBe(0);
  expect(await markEventsDelivered(db, { designId: one.design.id, ids: ids(claimed) })).toBe(1);
});

test("text Postgres cannot store is replaced in the payload, not refused", async () => {
  const { design } = await seedDesign(db);

  const event = await say(db, design.id, "cut \ud83d here\u0000");

  expect(event.payload).toEqual({ text: "cut \ufffd here\ufffd" });
});

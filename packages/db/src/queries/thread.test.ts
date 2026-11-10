import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDesign } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { QueryError } from "./run.ts";
import { appendThreadItem, listThreadItems, updateThreadItem } from "./thread.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("items come back in the order they were appended", async () => {
  const { design, user } = await seedDesign(db);

  const asked = await appendThreadItem(db, {
    designId: design.id,
    kind: "message",
    userId: user.id,
    payload: { text: "Make the hero shorter" },
  });
  await appendThreadItem(db, { designId: design.id, kind: "tool", payload: { name: "get_tree" } });
  await appendThreadItem(db, {
    designId: design.id,
    kind: "assistant",
    payload: { text: "Done." },
  });

  expect(asked).toMatchObject({ kind: "message", userId: user.id, streaming: false });
  expect(asked!.id).toMatch(/^ti_/);
  const thread = await listThreadItems(db, { designId: design.id });
  expect(thread.map((item) => item.kind)).toEqual(["message", "tool", "assistant"]);
  expect(thread[0]!.payload).toEqual({ text: "Make the hero shorter" });
  expect(thread[0]!.seq).toBeLessThan(thread[1]!.seq);
});

test("a thread is one design's", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await appendThreadItem(db, { designId: one.design.id, kind: "notice", payload: {} });

  expect(await listThreadItems(db, { designId: other.design.id })).toEqual([]);
});

test("posting an id again changes nothing and returns the item as it stands", async () => {
  const { design } = await seedDesign(db);
  const item = { id: "ti_retry", designId: design.id, kind: "assistant" as const };
  const first = await appendThreadItem(db, { ...item, payload: { text: "First" } });

  const again = await appendThreadItem(db, { ...item, payload: { text: "Second" } });

  expect(again).toEqual(first);
  expect(await listThreadItems(db, { designId: design.id })).toHaveLength(1);
});

test("an id cannot be used to reach into another design's thread", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await appendThreadItem(db, {
    id: "ti_theirs",
    designId: one.design.id,
    kind: "assistant",
    payload: { text: "Private" },
  });

  const reached = await appendThreadItem(db, {
    id: "ti_theirs",
    designId: other.design.id,
    kind: "assistant",
    payload: { text: "Mine now" },
  });

  expect(reached).toBeNull();
  const [theirs] = await listThreadItems(db, { designId: one.design.id });
  expect(theirs!.payload).toEqual({ text: "Private" });
});

test("a streaming item is replaced as text arrives, then closed", async () => {
  const { design } = await seedDesign(db);
  const item = await appendThreadItem(db, {
    designId: design.id,
    kind: "assistant",
    payload: { text: "" },
    streaming: true,
  });
  const update = (text: string, streaming: boolean) =>
    updateThreadItem(db, { designId: design.id, id: item!.id, payload: { text }, streaming });

  expect(await update("I'll shorten", true)).toMatchObject({
    payload: { text: "I'll shorten" },
    streaming: true,
  });
  const done = await update("I'll shorten the hero.", false);
  expect(done).toMatchObject({ payload: { text: "I'll shorten the hero." }, streaming: false });
  expect(done!.updatedAt.getTime()).toBeGreaterThanOrEqual(item!.updatedAt.getTime());

  // A partial that was still in the air when the item closed must not win.
  expect(await update("I'll sho", true)).toBeNull();
  const [stored] = await listThreadItems(db, { designId: design.id });
  expect(stored).toMatchObject({ payload: { text: "I'll shorten the hero." }, streaming: false });
});

test("an update needs the right design and an item that streams", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const streaming = await appendThreadItem(db, {
    designId: one.design.id,
    kind: "assistant",
    payload: {},
    streaming: true,
  });
  const finished = await appendThreadItem(db, {
    designId: one.design.id,
    kind: "message",
    payload: { text: "Hello" },
  });
  const change = { payload: { text: "Changed" }, streaming: false };

  expect(
    await updateThreadItem(db, { ...change, designId: other.design.id, id: streaming!.id }),
  ).toBeNull();
  expect(
    await updateThreadItem(db, { ...change, designId: one.design.id, id: finished!.id }),
  ).toBeNull();
  expect(
    await updateThreadItem(db, { ...change, designId: one.design.id, id: "ti_missing" }),
  ).toBeNull();
});

test("pages backwards from the newest", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["1", "2", "3", "4", "5"]) {
    await appendThreadItem(db, { designId: design.id, kind: "assistant", payload: { text } });
  }
  const texts = (items: { payload: unknown }[]) =>
    items.map((item) => (item.payload as { text: string }).text);

  const newest = await listThreadItems(db, { designId: design.id, limit: 2 });
  expect(texts(newest)).toEqual(["4", "5"]);
  const older = await listThreadItems(db, {
    designId: design.id,
    limit: 2,
    before: newest[0]!.seq,
  });
  expect(texts(older)).toEqual(["2", "3"]);
  const oldest = await listThreadItems(db, { designId: design.id, before: older[0]!.seq });
  expect(texts(oldest)).toEqual(["1"]);
});

test("tool output Postgres cannot store is kept, with the stray characters replaced", async () => {
  const { design } = await seedDesign(db);
  // A NUL from `cat` on a binary, and an emoji cut in half by truncation, in a key as well.
  const payload = {
    output: "PNG\u0000\u0001 done \ud83d",
    "bad\u0000key": ["ok \ud83d\ude00", "\ude00"],
  };

  const item = await appendThreadItem(db, {
    designId: design.id,
    kind: "assistant",
    payload,
    streaming: true,
  });
  const updated = await updateThreadItem(db, {
    designId: design.id,
    id: item!.id,
    payload: { text: "more\u0000" },
    streaming: false,
  });

  expect(item!.payload).toEqual({
    output: "PNG\ufffd\u0001 done \ufffd",
    "bad\ufffdkey": ["ok \ud83d\ude00", "\ufffd"],
  });
  expect(updated!.payload).toEqual({ text: "more\ufffd" });
});

test("a refused write says what Postgres said and none of what was sent", async () => {
  const { design } = await seedDesign(db);

  const error = await appendThreadItem(db, {
    designId: design.id,
    kind: "tool",
    payload: { output: `sk-live-secret ${"x".repeat(300_000)}` },
  }).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(QueryError);
  const refused = error as QueryError;
  expect(refused.message).toContain("thread_items_payload_check");
  expect(refused.statement).toContain('insert into "thread_items"');
  // Drizzle's own error lists every parameter after the statement.
  expect(`${refused.message}\n${refused.stack}\n${refused.statement}`).not.toContain("sk-live");
});

test("refuses a payload too large for a row that clients watch", async () => {
  const { design } = await seedDesign(db);
  const item = { designId: design.id, kind: "tool" as const };

  const fits = await appendThreadItem(db, { ...item, payload: { output: "x".repeat(200_000) } });
  expect(fits).not.toBeNull();
  await expect(
    appendThreadItem(db, { ...item, payload: { output: "x".repeat(300_000) } }),
  ).rejects.toThrow();
  expect(await listThreadItems(db, { designId: design.id })).toHaveLength(1);
});

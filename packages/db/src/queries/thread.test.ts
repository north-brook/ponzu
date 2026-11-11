import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedDesign, seedUser } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { QueryError } from "./run.ts";
import {
  appendThreadItem,
  appendThreadItemOnce,
  attachCommentPicture,
  listThreadItems,
  postMessage,
  type ThreadWrite,
  writeThreadItems,
} from "./thread.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const texts = (items: { payload: unknown }[]) =>
  items.map((item) => (item.payload as { text: string }).text);

test("items come back in the order they were appended", async () => {
  const { design, user } = await seedDesign(db);

  const asked = await appendThreadItem(db, {
    designId: design.id,
    kind: "message",
    userId: user.id,
    payload: { text: "Make the hero shorter" },
  });
  await appendThreadItem(db, { designId: design.id, kind: "tool", payload: { label: "Reading" } });
  await appendThreadItem(db, {
    designId: design.id,
    kind: "assistant",
    payload: { text: "Done." },
  });

  expect(asked).toMatchObject({ kind: "message", userId: user.id, streaming: false });
  expect(asked.id).toMatch(/^ti_/);
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

test("appending an id again changes nothing and returns the item as it stands", async () => {
  const { design } = await seedDesign(db);
  const item = { id: "ti_retry", designId: design.id, kind: "assistant" as const };
  const first = await appendThreadItem(db, { ...item, payload: { text: "First" } });

  const again = await appendThreadItem(db, { ...item, payload: { text: "Second" } });

  expect(again).toEqual(first);
  expect(await listThreadItems(db, { designId: design.id })).toHaveLength(1);
});

test("appending an id once adds it the first time and touches nothing after", async () => {
  const { design } = await seedDesign(db);
  const item = { id: "ti_pr-1-opened", designId: design.id, kind: "notice" as const };

  expect(await appendThreadItemOnce(db, { ...item, payload: { text: "First" } })).toBe(true);
  const [first] = await listThreadItems(db, { designId: design.id });
  expect(await appendThreadItemOnce(db, { ...item, payload: { text: "Second" } })).toBe(false);

  expect(await listThreadItems(db, { designId: design.id })).toEqual([first!]);
});

const write = (id: string, text: string, streaming: boolean): ThreadWrite => ({
  id,
  kind: "assistant",
  payload: { text },
  streaming,
});

test("a runner's write appends new items in order and answers each as it stands", async () => {
  const { design } = await seedDesign(db);
  const [a, b] = [newId("ti"), newId("ti")];

  const written = await writeThreadItems(db, {
    designId: design.id,
    items: [write(a, "one", true), write(b, "two", false)],
  });

  const thread = await listThreadItems(db, { designId: design.id });
  expect(texts(thread)).toEqual(["one", "two"]);
  expect(written).toEqual([
    { id: a, seq: thread[0]!.seq, streaming: true },
    { id: b, seq: thread[1]!.seq, streaming: false },
  ]);
});

test("a streaming item is replaced as it grows, and once finished never changes again", async () => {
  const { design } = await seedDesign(db);
  const id = newId("ti");
  const send = (text: string, streaming: boolean) =>
    writeThreadItems(db, { designId: design.id, items: [write(id, text, streaming)] });
  const [first] = await send("I'll", true);

  expect(await send("I'll shorten", true)).toEqual([{ ...first!, streaming: true }]);
  expect(await send("I'll shorten the hero.", false)).toEqual([{ ...first!, streaming: false }]);
  // A partial still in the air when the item finished, and a replay of the finish.
  expect(await send("I'll sho", true)).toEqual([{ ...first!, streaming: false }]);
  expect(await send("Something else", false)).toEqual([{ ...first!, streaming: false }]);

  const [stored] = await listThreadItems(db, { designId: design.id });
  expect(stored).toMatchObject({ payload: { text: "I'll shorten the hero." }, streaming: false });
});

test("a write cannot change an item's kind, nor reach another design's item of the same id", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const id = newId("ti");
  await writeThreadItems(db, { designId: one.design.id, items: [write(id, "theirs", true)] });

  await writeThreadItems(db, {
    designId: one.design.id,
    items: [{ id, kind: "tool", payload: { label: "x" }, streaming: true }],
  });
  const [mine] = await writeThreadItems(db, {
    designId: other.design.id,
    items: [write(id, "mine", false)],
  });

  expect((await listThreadItems(db, { designId: one.design.id }))[0]).toMatchObject({
    kind: "assistant",
    payload: { text: "theirs" },
    streaming: true,
  });
  expect(mine!.streaming).toBe(false);
  expect(texts(await listThreadItems(db, { designId: other.design.id }))).toEqual(["mine"]);
});

test("an item the API wrote is finished, so a runner's write cannot touch it", async () => {
  const { design, user } = await seedDesign(db);
  const message = await postMessage(db, {
    designId: design.id,
    userId: user.id,
    item: { text: "Hello" },
    event: { text: "Hello" },
  });

  await writeThreadItems(db, {
    designId: design.id,
    items: [{ id: message.id, kind: "notice", payload: { type: "waking" }, streaming: false }],
  });

  expect((await listThreadItems(db, { designId: design.id }))[0]).toMatchObject({
    kind: "message",
    payload: { text: "Hello" },
  });
});

test("a message is a thread item and a `now` event, written together", async () => {
  const { design, user } = await seedDesign(db);

  const item = await postMessage(db, {
    designId: design.id,
    userId: user.id,
    item: { text: "Make it blue", from: { id: user.id } },
    event: { text: "Make it blue" },
  });

  expect(item).toMatchObject({
    designId: design.id,
    kind: "message",
    userId: user.id,
    streaming: false,
    payload: { text: "Make it blue", from: { id: user.id } },
  });
  const feed = await db.select().from(events).where(eq(events.designId, design.id));
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({
    kind: "message",
    priority: "now",
    userId: user.id,
    payload: { text: "Make it blue" },
  });
});

test("pages backwards from the newest", async () => {
  const { design } = await seedDesign(db);
  for (const text of ["1", "2", "3", "4", "5"]) {
    await appendThreadItem(db, { designId: design.id, kind: "assistant", payload: { text } });
  }

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
    "bad\u0000key": ["ok 😀", "\ude00"],
  };
  const id = newId("ti");

  const item = await appendThreadItem(db, { designId: design.id, kind: "assistant", payload });
  await writeThreadItems(db, { designId: design.id, items: [write(id, "more\u0000", false)] });

  expect(item.payload).toEqual({
    output: "PNG�\u0001 done �",
    "bad�key": ["ok 😀", "�"],
  });
  expect((await listThreadItems(db, { designId: design.id }))[1]!.payload).toEqual({
    text: "more�",
  });
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
  // The driver's own error is still there for a caller that wants the code: a check violation.
  expect((refused.cause as { code?: string }).code).toBe("23514");
  // Drizzle's own error lists every parameter after the statement.
  expect(`${refused.message}\n${refused.stack}\n${refused.statement}`).not.toContain("sk-live");
});

test("refuses a payload too large for a row that clients watch", async () => {
  const { design } = await seedDesign(db);
  const item = { designId: design.id, kind: "tool" as const };

  await appendThreadItem(db, { ...item, payload: { output: "x".repeat(200_000) } });
  await expect(
    appendThreadItem(db, { ...item, payload: { output: "x".repeat(300_000) } }),
  ).rejects.toThrow();
  expect(await listThreadItems(db, { designId: design.id })).toHaveLength(1);
});

test("a comment keeps the first picture its author attaches, and nobody else's", async () => {
  const { design, user } = await seedDesign(db);
  const other = await seedUser(db, `sam${Date.now()}`);
  const comment = await appendThreadItem(db, {
    designId: design.id,
    kind: "comment",
    userId: user.id,
    payload: { threadId: "th_1", messageId: "m_1", text: "Tighter" },
  });
  const picture = { light: "comments/m_1-light.webp", dark: "comments/m_1-dark.webp" };
  const attach = (messageId: string, userId: string, given: Record<string, string> = picture) =>
    attachCommentPicture(db, { designId: design.id, messageId, userId, picture: given });

  // Not theirs, or no such comment: nothing changes.
  expect(await attach("m_1", other.id)).toBeNull();
  expect(await attach("m_2", user.id)).toBeNull();

  const attached = await attach("m_1", user.id);
  expect(attached).toMatchObject({ id: comment.id, payload: { text: "Tighter", picture } });

  // Again, with another: the first stays, and comes back.
  const again = await attach("m_1", user.id, { light: "comments/x.webp", dark: "comments/x.webp" });
  expect(again?.payload).toMatchObject({ picture });
  const [stored] = await listThreadItems(db, { designId: design.id });
  expect(stored!.payload).toEqual({ threadId: "th_1", messageId: "m_1", text: "Tighter", picture });
});

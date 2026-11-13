import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { events, type Json, threadItems } from "../schema/index.ts";
import { eventRow } from "./events.ts";
import { run } from "./run.ts";
import { insertMessageRow, type MessageSearch } from "./search.ts";
import { scrubbed } from "./text.ts";

export type ThreadItem = typeof threadItems.$inferSelect;

export interface NewThreadItem {
  /** Give the same id to post the same item again safely. Made up when left out. */
  id?: string;
  canvasId: string;
  kind: ThreadItem["kind"];
  /** The person who wrote it. Null for the agent and for Ponzu. */
  userId?: string | null;
  payload: Json;
  /** True for agent text that is still being written. */
  streaming?: boolean;
}

/**
 * Add an item to the end of a canvas's thread, for what the API writes itself (a pull
 * request's notice). Posting an id the canvas's thread already has changes nothing and answers
 * with the item as it stands; the same id in another canvas is another item.
 *
 * A NUL or half a surrogate pair in the payload, which tool output can hold and Postgres
 * cannot, is stored as U+FFFD. So it is in every write here.
 */
export async function appendThreadItem(db: Db, item: NewThreadItem): Promise<ThreadItem> {
  const [row] = await run(
    db
      .insert(threadItems)
      .values({ ...item, payload: scrubbed(item.payload), id: item.id ?? newId("ti") })
      .onConflictDoUpdate({
        target: [threadItems.canvasId, threadItems.id],
        // Sets the row to what it already holds, so that `returning` has it to return.
        set: { updatedAt: sql`${threadItems.updatedAt}` },
      })
      .returning(),
  );
  return row!;
}

/**
 * Add an item whose id the caller made to the end of a canvas's thread, unless the thread has
 * it already: true when it was added. Unlike `appendThreadItem`, posting it again writes
 * nothing at all, so the thread's watchers hear of it once.
 */
export async function appendThreadItemOnce(
  db: Db,
  item: NewThreadItem & { id: string },
): Promise<boolean> {
  const added = await run(
    db
      .insert(threadItems)
      .values({ ...item, payload: scrubbed(item.payload) })
      .onConflictDoNothing({ target: [threadItems.canvasId, threadItems.id] })
      .returning({ id: threadItems.id }),
  );
  return added.length > 0;
}

/** One item a runner writes: appended when new, its payload replaced while it streams. */
export interface ThreadWrite {
  id: string;
  kind: Extract<ThreadItem["kind"], "assistant" | "tool" | "notice">;
  payload: Json;
  streaming: boolean;
}

/** Where a written item stands afterwards. */
export interface WrittenItem {
  id: string;
  seq: number;
  streaming: boolean;
}

/**
 * Write a runner's items to a canvas's thread by their ids, in one statement: an id the thread
 * does not have is appended (in the order given), an item still streaming has its payload and
 * `streaming` replaced, and a finished one, or one of another kind, is left as it is. Every item
 * comes back as it stands, in the order given, so sending the same write again is safe and a
 * late write cannot reopen what has finished. The ids must be distinct.
 */
export async function writeThreadItems(
  db: Db,
  { canvasId, items }: { canvasId: string; items: ThreadWrite[] },
): Promise<WrittenItem[]> {
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("A thread write's ids must be distinct.");
  const written = db.$with("written").as(
    db
      .insert(threadItems)
      .values(items.map((item) => ({ ...item, canvasId, payload: scrubbed(item.payload) })))
      .onConflictDoUpdate({
        target: [threadItems.canvasId, threadItems.id],
        set: {
          payload: sql`excluded.payload`,
          streaming: sql`excluded.streaming`,
          updatedAt: sql`now()`,
        },
        setWhere: and(eq(threadItems.streaming, true), sql`${threadItems.kind} = excluded.kind`),
      })
      .returning({ id: threadItems.id, seq: threadItems.seq, streaming: threadItems.streaming }),
  );
  // Each id as the write left it, or, for one it left alone, as it stood before the statement
  // (which is what `thread_items` reads as here).
  const asked = sql`json_array_elements_text(${JSON.stringify(ids)}::json) with ordinality as asked(id, ord)`;
  const rows = await run(
    db
      .with(written)
      .select({
        id: sql<string>`asked.id`,
        seq: sql<number>`coalesce(${written.seq}, ${threadItems.seq})`.mapWith(Number),
        streaming: sql<boolean>`coalesce(${written.streaming}, ${threadItems.streaming})`,
      })
      .from(asked)
      .leftJoin(written, sql`${written.id} = asked.id`)
      .leftJoin(
        threadItems,
        and(eq(threadItems.canvasId, canvasId), sql`${threadItems.id} = asked.id`),
      )
      .orderBy(sql`asked.ord`),
  );
  return rows;
}

/**
 * A person's message: the thread item everyone sees and the `now` event that puts it into the
 * run, in one statement, so neither is ever there without the other. With `search`, the same
 * statement indexes it: an entry of kind `message` keyed by the item's id, with its seq and time.
 */
export async function postMessage(
  db: Db,
  {
    canvasId,
    userId,
    item,
    event,
    posthogSessionId = null,
    search,
  }: {
    canvasId: string;
    userId: string;
    item: Json;
    event: Json;
    /** The PostHog session of the app that sent it, if it said. */
    posthogSessionId?: string | null;
    /** The message as search finds it. Not indexed when left out. */
    search?: MessageSearch;
  },
): Promise<ThreadItem> {
  // Postgres runs a data-modifying `with` whether or not the statement reads it.
  const queued = db.$with("queued").as(
    db
      .insert(events)
      .values({
        canvasId,
        ...eventRow({ kind: "message", priority: "now", payload: event, userId, posthogSessionId }),
      })
      .returning({ id: events.id }),
  );
  const values = {
    id: newId("ti"),
    canvasId,
    kind: "message" as const,
    userId,
    payload: scrubbed(item),
  };
  const message = search && insertMessageRow(canvasId, search, "said");
  if (!message) {
    const [row] = await run(db.with(queued).insert(threadItems).values(values).returning());
    return row!;
  }
  // The entry needs the item's seq, which only the inserted row has, so the item is inserted in
  // a `with` of its own and the statement answers with it from there.
  const said = db.$with("said").as(db.insert(threadItems).values(values).returning());
  const indexed = db
    .$with("indexed", { canvasId: sql<string>`canvas_id` })
    .as(sql`${message} returning canvas_id`);
  const [row] = await run(db.with(queued, said, indexed).select().from(said));
  return row!;
}

/** The `comment` item of `messageId` that `userId` wrote, or null while there is none. */
export async function getComment(
  db: Db,
  { canvasId, messageId, userId }: { canvasId: string; messageId: string; userId: string },
): Promise<ThreadItem | null> {
  const [row] = await run(
    db
      .select()
      .from(threadItems)
      .where(
        and(
          eq(threadItems.canvasId, canvasId),
          eq(threadItems.kind, "comment"),
          eq(threadItems.userId, userId),
          sql`${threadItems.payload}->>'messageId' = ${messageId}`,
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * Give a person's comment its picture (`payload.picture`): the `comment` item of `messageId`
 * that `userId` wrote. The first picture is the one it keeps, as a photo sent is: attaching
 * again changes nothing. Answers the item as it stands, picture and all, or null when the canvas
 * has no such comment of theirs (its op not committed yet, or never).
 */
export async function attachCommentPicture(
  db: Db,
  {
    canvasId,
    messageId,
    userId,
    picture,
  }: { canvasId: string; messageId: string; userId: string; picture: Json },
): Promise<ThreadItem | null> {
  const theirs = and(
    eq(threadItems.canvasId, canvasId),
    eq(threadItems.kind, "comment"),
    eq(threadItems.userId, userId),
    sql`${threadItems.payload}->>'messageId' = ${messageId}`,
  );
  const attached = db.$with("attached").as(
    db
      .update(threadItems)
      .set({
        payload: sql`${threadItems.payload} || jsonb_build_object('picture', ${JSON.stringify(picture)}::jsonb)`,
        updatedAt: sql`now()`,
      })
      .where(and(theirs, sql`not (${threadItems.payload} ? 'picture')`))
      .returning(),
  );
  // The item as the update left it, or as it was when it had a picture already (`thread_items`
  // reads as before the statement here).
  const [row] = await run(
    db
      .with(attached)
      .select({
        before: threadItems,
        payload: sql<Json | null>`${attached.payload}`,
        updatedAt: sql<string | null>`${attached.updatedAt}`,
      })
      .from(threadItems)
      .leftJoin(attached, eq(attached.id, threadItems.id))
      .where(theirs),
  );
  if (!row) return null;
  const { before, payload, updatedAt } = row;
  return payload === null
    ? before
    : { ...before, payload, updatedAt: updatedAt ? new Date(updatedAt) : before.updatedAt };
}

/** A page of a canvas's thread, oldest first: the newest `limit` items, or those before `before`. */
export async function listThreadItems(
  db: Db,
  { canvasId, before, limit = 100 }: { canvasId: string; before?: number; limit?: number },
): Promise<ThreadItem[]> {
  const rows = await run(
    db
      .select()
      .from(threadItems)
      .where(
        and(
          eq(threadItems.canvasId, canvasId),
          before === undefined ? undefined : lt(threadItems.seq, before),
        ),
      )
      .orderBy(desc(threadItems.seq))
      .limit(limit),
  );
  return rows.reverse();
}

/** A page of a canvas's thread, oldest first: the first `limit` items after seq `after`. */
export async function listThreadItemsAfter(
  db: Db,
  { canvasId, after, limit }: { canvasId: string; after: number; limit: number },
): Promise<ThreadItem[]> {
  return run(
    db
      .select()
      .from(threadItems)
      .where(and(eq(threadItems.canvasId, canvasId), sql`${threadItems.seq} > ${after}`))
      .orderBy(threadItems.seq)
      .limit(limit),
  );
}

/** Items of a canvas's thread by id, in thread order. An id the thread does not have is left out. */
export async function getThreadItems(
  db: Db,
  { canvasId, ids }: { canvasId: string; ids: readonly string[] },
): Promise<ThreadItem[]> {
  if (ids.length === 0) return [];
  return run(
    db
      .select()
      .from(threadItems)
      .where(and(eq(threadItems.canvasId, canvasId), inArray(threadItems.id, [...ids])))
      .orderBy(threadItems.seq),
  );
}

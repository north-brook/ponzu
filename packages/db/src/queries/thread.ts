import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { type Json, threadItems } from "../schema/index.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type ThreadItem = typeof threadItems.$inferSelect;

export interface NewThreadItem {
  /** Give the same id to post the same item again safely. Made up when left out. */
  id?: string;
  designId: string;
  kind: ThreadItem["kind"];
  /** The person who wrote it. Null for the agent and for Ponzu. */
  userId?: string | null;
  payload: Json;
  /** True for agent text that is still being written; finish it with `updateThreadItem`. */
  streaming?: boolean;
}

/**
 * Add an item to the end of a design's thread. Posting an id that is already there changes
 * nothing and answers with the item as it stands. Null if that id belongs to another design.
 *
 * A NUL or half a surrogate pair in the payload, which tool output can hold and Postgres
 * cannot, is stored as U+FFFD; `updateThreadItem` does the same.
 */
export async function appendThreadItem(db: Db, item: NewThreadItem): Promise<ThreadItem | null> {
  const [row] = await run(
    db
      .insert(threadItems)
      .values({ ...item, payload: scrubbed(item.payload), id: item.id ?? newId("ti") })
      .onConflictDoUpdate({
        target: threadItems.id,
        // Sets the row to what it already holds, so that `returning` has it to return.
        set: { updatedAt: sql`${threadItems.updatedAt}` },
        setWhere: eq(threadItems.designId, item.designId),
      })
      .returning(),
  );
  return row ?? null;
}

/**
 * Replace a streaming item's payload as more of it arrives, and end the stream with
 * `streaming: false`. Null when there is no such item or it has already ended, so an update
 * that arrives late cannot overwrite the finished text.
 */
export async function updateThreadItem(
  db: Db,
  {
    designId,
    id,
    payload,
    streaming,
  }: { designId: string; id: string; payload: Json; streaming: boolean },
): Promise<ThreadItem | null> {
  const [row] = await run(
    db
      .update(threadItems)
      .set({ payload: scrubbed(payload), streaming })
      .where(
        and(
          eq(threadItems.id, id),
          eq(threadItems.designId, designId),
          eq(threadItems.streaming, true),
        ),
      )
      .returning(),
  );
  return row ?? null;
}

/** A page of a design's thread, oldest first: the newest `limit` items, or those before `before`. */
export async function listThreadItems(
  db: Db,
  { designId, before, limit = 100 }: { designId: string; before?: number; limit?: number },
): Promise<ThreadItem[]> {
  const rows = await run(
    db
      .select()
      .from(threadItems)
      .where(
        and(
          eq(threadItems.designId, designId),
          before === undefined ? undefined : lt(threadItems.seq, before),
        ),
      )
      .orderBy(desc(threadItems.seq))
      .limit(limit),
  );
  return rows.reverse();
}

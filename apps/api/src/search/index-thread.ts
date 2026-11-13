import type { SearchAuthor, SearchEntry } from "@ponzu/core";
import {
  enqueueJob,
  getThreadItems,
  SEARCH_REINDEX_JOB,
  type SearchReindexPayload,
  type ThreadItem,
  upsertSearchEntries,
} from "@ponzu/db";
import type { ThreadWrite, TurnRecord } from "@ponzu/runner/protocol";
import { AGENT } from "../canvases/actor.ts";
import type { Deps } from "../deps/index.ts";
import { plainText } from "./plain.ts";

/*
 * What a canvas's thread puts into search (docs/cloud.md "Search"): each person's message, and
 * the agent's answer of each turn that ended with one (`turn.final`). Asides, tool steps,
 * notices and the `comment` items (copies of the document's comments, which the commit indexes)
 * are never indexed, and neither is anything said in a turn that is still running or that
 * stopped or failed before it answered.
 *
 * A person's message is indexed by the statement that posts it (`postMessage`). The agent's
 * answers are indexed here, after the runner's thread write, in a statement of their own.
 */

/** The agent, as search names the author of its answers. */
export const AGENT_AUTHOR: SearchAuthor = { kind: "agent", id: AGENT.id, name: AGENT.name };

/** A turn's record, when `item` is a turn's work item that carries one. */
export function turnOf(item: { kind: string; payload: unknown }): TurnRecord | null {
  if (item.kind !== "tool") return null;
  const turn = (item.payload as { turn?: TurnRecord } | null)?.turn;
  return turn && typeof turn === "object" ? turn : null;
}

/** The id of the answer a turn's record names, once the turn has ended; else null. */
export function finalOf(turn: TurnRecord | null): string | null {
  return turn && turn.ended !== null && typeof turn.final === "string" ? turn.final : null;
}

/** The entry of the agent's answer `item` (an `assistant` item), or null when it has no words. */
export function answerEntry(item: ThreadItem): SearchEntry | null {
  if (item.kind !== "assistant") return null;
  const markdown = (item.payload as { text?: unknown }).text;
  if (typeof markdown !== "string") return null;
  const text = plainText(markdown);
  if (text.trim() === "") return null;
  return {
    kind: "message",
    ref: item.id,
    text,
    context: { kind: "message", itemSeq: item.seq },
    author: AGENT_AUTHOR,
    at: item.createdAt.getTime(),
  };
}

/** The entry of a person's message `item`, as `postMessage` writes it. */
export function personEntry(item: ThreadItem): SearchEntry | null {
  if (item.kind !== "message") return null;
  const { text, from } = item.payload as {
    text?: unknown;
    from?: { id?: unknown; name?: unknown };
  };
  if (typeof text !== "string" || text.trim() === "") return null;
  return {
    kind: "message",
    ref: item.id,
    text,
    context: { kind: "message", itemSeq: item.seq },
    author: {
      kind: "user",
      id: typeof from?.id === "string" ? from.id : item.userId,
      name: typeof from?.name === "string" ? from.name : "",
    },
    at: item.createdAt.getTime(),
  };
}

/**
 * Index the answers of the turns a runner's thread write ended: for each finished work item in
 * `items` whose turn ended with a `final`, that `assistant` item, read back from the thread.
 * Safe to repeat: writing the same entry again changes nothing.
 *
 * Never throws. A failure is logged as `search_index_failed`, with the canvas id alone, and a
 * reindex of the canvas is recorded to repair it; the runner's write has already landed and is
 * answered as before. Answers how many entries were written.
 */
export async function indexTurnAnswers(
  deps: Pick<Deps, "db" | "log" | "clock">,
  canvasId: string,
  items: readonly ThreadWrite[],
): Promise<number> {
  const finals = [
    ...new Set(
      items.flatMap((item) => {
        if (item.kind !== "tool" || item.streaming) return [];
        const final = finalOf(turnOf(item));
        return final ? [final] : [];
      }),
    ),
  ];
  if (finals.length === 0) return 0;
  try {
    const answers = await getThreadItems(deps.db, { canvasId, ids: finals });
    const settled = answers.filter((item) => !item.streaming);
    const entries = settled.flatMap((item) => answerEntry(item) ?? []);
    const written = await upsertSearchEntries(deps.db, { canvasId, entries });
    // An answer not in the thread yet, or still streaming there: the runner's writer can send
    // a turn's ending and its answer's last words in separate writes, and no later write names
    // the turn again. The reindex picks it up once it has landed.
    if (settled.length < finals.length) await queueReindex(deps, canvasId);
    return written;
  } catch (error) {
    deps.log.error("search_index_failed", { canvasId, error });
    await queueReindex(deps, canvasId);
    return 0;
  }
}

/**
 * Record a reindex of the canvas, due now (the API's clock, as the cron claims by it), unless
 * one is waiting already. Never throws.
 */
export async function queueReindex(
  deps: Pick<Deps, "db" | "log" | "clock">,
  canvasId: string,
): Promise<void> {
  try {
    const payload: SearchReindexPayload = { canvasId };
    await enqueueJob(deps.db, {
      kind: SEARCH_REINDEX_JOB,
      key: canvasId,
      payload: { ...payload },
      runAt: new Date(deps.clock.now()),
    });
  } catch (error) {
    deps.log.error("search_reindex_queue_failed", { canvasId, error });
  }
}

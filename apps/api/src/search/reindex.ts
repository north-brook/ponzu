import { applyOp, docSearchEntries, SEARCH_VERSION, type SearchEntry } from "@ponzu/core";
import {
  deleteSearchEntries,
  listThreadItemsAfter,
  readDocSource,
  replaceDocSearchEntries,
  type SearchKey,
  upsertSearchEntries,
} from "@ponzu/db";
import type { TurnRecord } from "@ponzu/runner/protocol";
import { z } from "zod";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps } from "../jobs/run.ts";
import { answerEntry, finalOf, personEntry, turnOf } from "./index-thread.ts";

/*
 * Rebuilding one canvas's search entries whole (docs/cloud.md "Search"): the job kind
 * `search.reindex`, keyed by the canvas id. The cron's backfill step queues it for canvases no
 * reindex has done at the current SEARCH_VERSION, and an index write that failed queues it to
 * repair. Safe to repeat.
 */

/** How many times the document is read again when a commit moved it during the write. */
const DOC_ATTEMPTS = 3;
/** How long to wait before trying again when commits kept moving it. */
const BUSY_RETRY_MS = 30_000;
/**
 * How long to wait before reading the thread again when an ended turn's answer is still
 * streaming, or not written yet: the runner sends a turn's ending and its answer's last words in
 * separate writes, and the later one names no turn, so nothing else would index it again.
 */
const UNSETTLED_RETRY_MS = 15_000;
/** Thread items read, and entries written, per statement. */
const THREAD_PAGE = 500;

const Payload = z.object({ canvasId: z.string().min(1).max(64) });

/** What one reindex did. */
export interface Reindexed {
  /** The document's entries now stored (its name, pages, boards and comments). */
  doc: number;
  /** People's messages and the agent's answers written. */
  messages: number;
  /** Agent's messages whose entry was removed, as their turn names another answer. */
  removed: number;
}

/** The `search.reindex` job's handler. */
export async function runSearchReindexJob(
  deps: Pick<JobDeps, "db" | "log">,
  payload: unknown,
): Promise<void> {
  const { canvasId } = Payload.parse(payload);
  const done = await reindexCanvas(deps, canvasId);
  // Ids and counts only: never what the entries say.
  deps.log.info("search_reindexed", { canvasId, ...(done ?? { gone: true }) });
}

/**
 * Rebuild a canvas's entries: replace its document's entries with those of its document as it
 * now stands (reading it again if a commit moves it meanwhile, up to DOC_ATTEMPTS times, then
 * `RetryLater`), then write its thread's: each person's message, each ended turn's answer, and
 * each finished answer from before turns had records. Null when there is no such canvas.
 */
export async function reindexCanvas(
  deps: Pick<JobDeps, "db">,
  canvasId: string,
): Promise<Reindexed | null> {
  let doc: SearchEntry[] | null = null;
  for (let attempt = 0; attempt < DOC_ATTEMPTS && doc === null; attempt++) {
    const source = await readDocSource(deps.db, canvasId);
    if (!source) return null;
    const current = source.checkpoint.doc;
    for (const stored of source.ops) applyOp(current, stored.op);
    const entries = docSearchEntries(current);
    const applied = await replaceDocSearchEntries(deps.db, {
      canvasId,
      seq: source.seq,
      entries,
      version: SEARCH_VERSION,
    });
    if (applied) doc = entries;
  }
  if (doc === null) {
    throw new RetryLater(BUSY_RETRY_MS, "The canvas kept changing while it was reindexed.");
  }
  const { unsettled, ...thread } = await reindexThread(deps, canvasId);
  if (unsettled > 0) {
    // What there is is written; the job runs again for the answers still to come.
    throw new RetryLater(UNSETTLED_RETRY_MS, "An ended turn's answer has not settled yet.");
  }
  return { doc: doc.length, ...thread };
}

/**
 * Write the entries a canvas's thread holds, page by page from its start. An `assistant` item
 * belongs to the turn whose work item came last before it. In a turn that has ended, its
 * `final` is indexed and every other answer of the turn (an aside) loses any entry it has; in a
 * turn still running nothing is touched. An `assistant` item with no turn record before it was
 * written by a runner from before turns had records, and is indexed once finished. `unsettled`
 * counts ended turns whose answer is still streaming (indexed as it stands, for now) or not in
 * the thread yet.
 */
async function reindexThread(
  deps: Pick<JobDeps, "db">,
  canvasId: string,
): Promise<{ messages: number; removed: number; unsettled: number }> {
  let messages = 0;
  let removed = 0;
  /** Ended turns' answers not yet seen whole. */
  const awaited = new Set<string>();
  let after = 0;
  let turn: TurnRecord | null = null;
  for (;;) {
    const page = await listThreadItemsAfter(deps.db, { canvasId, after, limit: THREAD_PAGE });
    if (page.length === 0) break;
    const entries: SearchEntry[] = [];
    const gone: SearchKey[] = [];
    for (const item of page) {
      if (item.kind === "tool") {
        turn = turnOf(item);
        const final = finalOf(turn);
        if (final) awaited.add(final);
      } else if (item.kind === "message") {
        const entry = personEntry(item);
        if (entry) entries.push(entry);
      } else if (item.kind === "assistant") {
        if (turn === null) {
          const entry = item.streaming ? null : answerEntry(item);
          if (entry) entries.push(entry);
        } else if (turn.ended !== null) {
          const final = finalOf(turn) === item.id;
          if (final && !item.streaming) awaited.delete(item.id);
          const entry = final ? answerEntry(item) : null;
          if (entry) entries.push(entry);
          else gone.push({ kind: "message", ref: item.id });
        }
      }
    }
    messages += await upsertSearchEntries(deps.db, { canvasId, entries });
    removed += await deleteSearchEntries(deps.db, { canvasId, keys: gone });
    after = page[page.length - 1]!.seq;
    if (page.length < THREAD_PAGE) break;
  }
  return { messages, removed, unsettled: awaited.size };
}

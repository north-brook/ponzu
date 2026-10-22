import { applyOp, type Doc, type Op } from "./doc.ts";
import type { Origin } from "./protocol.ts";

/**
 * A design's history, one JSON object per line in `.ponzu/journal.ndjson`:
 * every op with when it happened and who made it, across every session, plus
 * a full copy of the doc wherever replaying the ops alone can't be trusted
 * (when the journal starts, after the folder was changed in a way that
 * couldn't become ops, and when the file opens and doesn't match). Timelapses
 * are made from it afterwards.
 */
export const JOURNAL_FILE = ".ponzu/journal.ndjson";

/** Who made a change, as the journal keeps it. `client` is the agent's product, for its mark. */
export type JournalOrigin = Origin & { client?: string };

export type JournalEntry =
  | { v: 1; t: number; kind: "checkpoint"; doc: Doc }
  | { v: 1; t: number; kind: "op"; op: Op; origin: JournalOrigin; artboards: string[] };

export type OpEntry = Extract<JournalEntry, { kind: "op" }>;

export function checkpointLine(doc: Doc, t = Date.now()): string {
  return `${JSON.stringify({ v: 1, t, kind: "checkpoint", doc } satisfies JournalEntry)}\n`;
}

export function opLine(op: Op, origin: JournalOrigin, artboards: string[], t = Date.now()): string {
  const o: JournalOrigin = { kind: origin.kind, name: origin.name };
  if (origin.client) o.client = origin.client;
  return `${JSON.stringify({ v: 1, t, kind: "op", op, origin: o, artboards } satisfies JournalEntry)}\n`;
}

/**
 * Entries in order. A line that doesn't parse is skipped: the last one may be
 * half written if the process died mid-append.
 */
export function parseJournal(text: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEntry(e)) out.push(e);
  }
  return out;
}

function isEntry(e: unknown): e is JournalEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  if (x.v !== 1 || typeof x.t !== "number") return false;
  if (x.kind === "checkpoint") return Boolean(x.doc && typeof x.doc === "object");
  if (x.kind === "op") return Boolean(x.op && x.origin && Array.isArray(x.artboards));
  return false;
}

/**
 * The doc as it stood at time `t` (inclusive), from the latest checkpoint at
 * or before it. Ops that no longer fit (the folder changed underneath) are
 * skipped; the next checkpoint puts things right. Null before the first
 * checkpoint.
 */
export function docAt(entries: JournalEntry[], t: number): Doc | null {
  let start = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.t > t) break;
    if (e.kind === "checkpoint") start = i;
  }
  if (start < 0) return null;
  const doc = structuredClone(
    (entries[start] as Extract<JournalEntry, { kind: "checkpoint" }>).doc,
  );
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.t > t) break;
    if (e.kind === "op") tryApply(doc, e.op);
  }
  return doc;
}

/** The doc after every entry. */
export function latestDoc(entries: JournalEntry[]): Doc | null {
  return docAt(entries, Number.POSITIVE_INFINITY);
}

/** Apply an op, reporting whether it fit. */
export function tryApply(doc: Doc, op: Op): boolean {
  try {
    applyOp(doc, op);
    return true;
  } catch {
    return false;
  }
}

/** Past this, the journal is cut down to its newer half. */
export const JOURNAL_LIMIT = 48 * 1024 * 1024;

/**
 * The journal from `t` on: a checkpoint of the doc at `t`, then every later
 * entry. What a journal that grew too big is rewritten to.
 */
export function compactJournal(entries: JournalEntry[], t: number): string {
  const doc = docAt(entries, t);
  const later = entries.filter((e) => e.t > t);
  if (!doc) return later.map((e) => `${JSON.stringify(e)}\n`).join("");
  return checkpointLine(doc, t) + later.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/**
 * Where to cut a journal of `bytes` that's over the limit: the time of the
 * entry where the newer half (by size) begins, moved back to the start of
 * that session so a film of it is whole. Sizes are each line's length.
 */
export function compactionPoint(
  entries: JournalEntry[],
  sizes: number[],
  keep = JOURNAL_LIMIT / 2,
): number {
  let kept = 0;
  let i = entries.length - 1;
  for (; i > 0; i--) {
    kept += sizes[i] ?? 0;
    if (kept >= keep) break;
  }
  // The entry just before index i is the last one dropped.
  return entries[Math.max(0, i - 1)]?.t ?? 0;
}

/**
 * The doc after entries[0..upto], by index: the latest checkpoint at or
 * before `upto`, then the ops after it. Null with no checkpoint yet.
 */
export function replayTo(entries: JournalEntry[], upto: number): Doc | null {
  let start = -1;
  for (let i = Math.min(upto, entries.length - 1); i >= 0; i--) {
    if (entries[i]!.kind === "checkpoint") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const doc = structuredClone(
    (entries[start] as Extract<JournalEntry, { kind: "checkpoint" }>).doc,
  );
  for (let i = start + 1; i <= upto && i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === "op") tryApply(doc, e.op);
  }
  return doc;
}

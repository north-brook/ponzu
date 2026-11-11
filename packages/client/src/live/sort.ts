import type { ThreadItem } from "@ponzu/runner/protocol";
import type { DesignListRow, PresenceRow, QuestionRow } from "./rows.ts";

/*
 * Live queries cannot ORDER BY (each change would re-send the whole result), so the lists are
 * put in order here. Each returns a new array and leaves the one it was given alone.
 */

/** The sidebar's order: most recently active first. */
export function byRecentActivity(designs: readonly DesignListRow[]): DesignListRow[] {
  return [...designs].sort(
    (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id),
  );
}

/** The thread, or a design's questions, in the order they were written. */
export function bySeq<Row extends ThreadItem | QuestionRow>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => a.seq - b.seq);
}

/** How long a presence row lasts without being refreshed (docs/cloud.md, "Realtime"). */
export const PRESENCE_TTL_MS = 75_000;

/**
 * Who has the design open as of `now`, longest here first. A row whose `seenAt` is older than
 * 75 seconds is someone who left without saying so; the API's sweeper deletes it later.
 */
export function presentNow(rows: readonly PresenceRow[], now: number): PresenceRow[] {
  return rows
    .filter((row) => now - Date.parse(row.seenAt) <= PRESENCE_TTL_MS)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId));
}

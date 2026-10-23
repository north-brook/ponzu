import type { Presence } from "./protocol.ts";

/**
 * What an agent is doing in a file. `working` while it changes artboards
 * (see `Presence.working`); `iterating` while it runs the iterate
 * loop, i.e. waiting in wait_for_activity or handling what it heard from it;
 * otherwise nothing the person needs to see.
 */
export type AgentActivity = "working" | "iterating" | null;

/** A loop's turn (read, edit, screenshot, resolve) between two waits rarely takes longer. */
export const LOOP_GAP = 2 * 60_000;

export function agentActivity(p: Presence, file: string, now = Date.now()): AgentActivity {
  if (p.kind !== "agent" || (p.file && p.file !== file)) return null;
  if (p.working.length) return "working";
  if (!p.file) return null;
  if (p.listening || (p.listenedAt && now - p.listenedAt < LOOP_GAP)) return "iterating";
  return null;
}

/**
 * What an agent changed in a design, for the phone's Activity: one entry per
 * run of edits by the same agent in the same design, a couple of minutes
 * apart at most. `GET /api/activity` lists them, newest first.
 */
export interface AgentChange {
  /** Stable while the entry grows, so a list keeps its place. */
  id: string;
  /** The design's key: the path of its .design folder on that Mac. */
  file: string;
  /** The design's name when the change was made. */
  name: string;
  /** The first and last edit of the run, ms since the epoch. */
  start: number;
  at: number;
  agent: { name: string; client?: string };
  /** The artboards it touched, as they were named then. `thumb` for those still there. */
  artboards: { id: string; name: string; page: string; thumb?: string }[];
  /** A few words on the last edit, as wait_for_activity reports it. */
  summary: string;
  /** Every artboard new (`added`) or gone (`removed`) in the run, or else `changed`. */
  kind: "changed" | "added" | "removed";
}

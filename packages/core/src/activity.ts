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

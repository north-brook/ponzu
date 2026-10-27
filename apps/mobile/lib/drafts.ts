import { useSyncExternalStore } from "react";
import type { PendingPin } from "../canvas/protocol";

export interface Draft {
  text: string;
  /** The thread a reply is in. */
  thread?: string;
  /** Where a new comment goes. */
  pin?: PendingPin & { nodeId?: string };
}

/**
 * Unsent words, by what they're for (a new comment's pin, or a thread): kept as the composer
 * moves (iPhone Duo folds and opens it from the sheet to the panel or the half beside the
 * design), when its sheet is swiped away, and when an agent changes the thread under it. Gone
 * once they're sent, or the field is emptied. As desktop's (packages/react/src/drafts.ts).
 */
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let all: [string, Draft][] = [];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const draftKey = {
  comment: (p: PendingPin) => `pin:${p.artboardId ?? p.pageId}:${p.x}:${p.y}`,
  reply: (thread: string) => `thread:${thread}`,
};

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

/** Keep what a field holds; emptied, its draft goes. */
export function setDraft(key: string, draft: Draft) {
  if (draft.text) drafts.set(key, draft);
  else if (!drafts.delete(key)) return;
  all = [...drafts];
  for (const l of listeners) l();
}

/** Whether a draft holds anything worth keeping a place for. */
export function unsent(d: Draft): boolean {
  return d.text.trim().length > 0;
}

/** Every draft, with its key. */
export function useDrafts(): [string, Draft][] {
  return useSyncExternalStore(
    subscribe,
    () => all,
    () => all,
  );
}

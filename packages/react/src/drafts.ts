import { useCallback, useSyncExternalStore } from "react";

/** Where a new comment's unsent words sit: a Thread's place, before it is one. */
export interface DraftPin {
  /** Absent for a comment on the open canvas. */
  artboardId?: string;
  pageId: string;
  nodeId?: string;
  x: number;
  y: number;
}

export interface Draft {
  /** The design it's in, by its key. */
  file: string;
  text: string;
  /** The thread a reply or an edit is in. */
  thread?: string;
  /** Where a new comment goes. */
  pin?: DraftPin;
}

/**
 * Words typed and not sent yet, by what they're for: a new comment's spot, a reply, an edit.
 * They outlive the field they were typed in, so a click away, Esc, a page change or an agent
 * closing the card never throws them out. Sending them, or emptying the field, does.
 */
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let all: Draft[] = [];

function changed() {
  all = [...drafts.values()];
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const draftKey = {
  comment: (file: string, p: DraftPin) => `${file}\0new:${p.artboardId ?? p.pageId}:${p.x}:${p.y}`,
  reply: (file: string, thread: string) => `${file}\0reply:${thread}`,
  edit: (file: string, message: string) => `${file}\0edit:${message}`,
};

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

/** Keep a draft, or drop it with null. */
export function setDraft(key: string, draft: Draft | null) {
  if (draft) drafts.set(key, draft);
  else if (!drafts.delete(key)) return;
  changed();
}

/**
 * A new comment's draft dragged to another spot: its words go with its pin, kept under the key
 * the new spot makes; put down where it was, it still takes the layer now under it. Nothing
 * written there yet, there's nothing to move.
 */
export function moveDraft(from: string, to: string, pin: DraftPin) {
  const d = drafts.get(from);
  if (!d) return;
  drafts.delete(from);
  drafts.set(to, { ...d, pin });
  changed();
}

/** Whether a draft holds anything worth keeping a place for. */
export function unsent(d: Draft): boolean {
  return d.text.trim().length > 0;
}

/**
 * A field's text, kept under `key`: what it held last time comes back when it opens again. Back
 * to `initial`, there's no draft.
 */
export function useDraft(
  key: string,
  about: Omit<Draft, "text">,
  initial = "",
): [string, (text: string) => void] {
  const read = () => drafts.get(key)?.text ?? null;
  const text = useSyncExternalStore(subscribe, read, read);
  const { file, thread, pin } = about;
  const set = useCallback(
    (t: string) => setDraft(key, t === initial ? null : { file, thread, pin, text: t }),
    [key, file, thread, pin, initial],
  );
  return [text ?? initial, set];
}

/** Every draft, in every design. */
export function useDrafts(): Draft[] {
  return useSyncExternalStore(
    subscribe,
    () => all,
    () => all,
  );
}

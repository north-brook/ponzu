import { useCallback, useSyncExternalStore } from "react";
import type { PendingAttachment, SteerGate } from "../model.ts";

/** The composer's round button: Stop, Send, or Send that can't send yet. */
export type ComposerButton = "stop" | "send" | "waiting";

/**
 * Stop while the agent works and there is nothing to say; Send as soon as there is, even
 * mid-run: the message goes straight into the run. A message needs words (an image alone says
 * nothing to the agent) and every attachment uploaded. While the run waits on its owner's
 * Claude nothing sends, but a run still going can be stopped.
 */
export function composerButton({
  working,
  text,
  attachments,
  gate,
}: {
  working: boolean;
  text: string;
  attachments: PendingAttachment[];
  gate: SteerGate | null;
}): ComposerButton {
  const said = text.trim().length > 0;
  if (working && !said) return "stop";
  if (gate || !said) return "waiting";
  return attachments.every((a) => a.status === "ready") ? "send" : "waiting";
}

/*
 * Drafts: what someone started typing to a design stays with that design, through switching
 * designs and restarting the app. Kept in the browser's storage, one key per design, and
 * nowhere else: a draft is the person's own until they send it.
 */

const PREFIX = "ponzu.draft.";
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Without storage (a locked-down window), drafts last as long as the page. */
const memory = new Map<string, string>();

export function readDraft(designId: string): string {
  try {
    return storage()?.getItem(PREFIX + designId) ?? memory.get(designId) ?? "";
  } catch {
    return memory.get(designId) ?? "";
  }
}

export function writeDraft(designId: string, text: string): void {
  const empty = !text.trim();
  if (empty) memory.delete(designId);
  else memory.set(designId, text);
  try {
    if (empty) storage()?.removeItem(PREFIX + designId);
    else storage()?.setItem(PREFIX + designId, text);
  } catch {
    // Full or refused: the copy in memory holds it for now.
  }
  for (const listener of listeners) listener();
}

/** The draft for a design, and a setter that keeps it. */
export function useDraft(designId: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readDraft(designId),
  );
  const set = useCallback((next: string) => writeDraft(designId, next), [designId]);
  return [text, set];
}

import { useCallback, useSyncExternalStore } from "react";
import type { PendingAttachment, SteerGate } from "../model.ts";

/** The composer's round button: Stop, Send, or Send that can't send yet. */
export type ComposerButton = "stop" | "send" | "waiting";

/**
 * Whether a gate keeps the composer from sending. A plan at its limit does not: the message
 * waits in the feed and goes in when the plan resets, as the line under the gate says. Any other
 * wait on the owner's Claude does, until someone acts on it.
 */
export function composerHolds(gate: SteerGate | null): boolean {
  return gate !== null && gate.kind !== "claude_limit";
}

/**
 * Stop while the agent works and there is nothing to say; Send as soon as there is, even
 * mid-run: the message goes straight into the run. A message needs words (an image alone says
 * nothing to the agent) and every attachment uploaded. While the run waits on its owner's
 * Claude being connected nothing sends, but a run still going can be stopped.
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
  if (composerHolds(gate) || !said) return "waiting";
  return attachments.every((a) => a.status === "ready") ? "send" : "waiting";
}

/*
 * Drafts: what someone started typing to a canvas stays with that canvas, through switching
 * canvases and restarting the app. Kept in the browser's storage, one key per person and canvas,
 * and nowhere else: a draft is the person's own until they send it, so someone else signing in
 * on the same Mac never sees it, and signing out clears them all.
 */

const PREFIX = "ponzu.draft.";
const keyOf = (meId: string, canvasId: string) => `${PREFIX}${meId}.${canvasId}`;
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

export function readDraft(meId: string, canvasId: string): string {
  const key = keyOf(meId, canvasId);
  try {
    return storage()?.getItem(key) ?? memory.get(key) ?? "";
  } catch {
    return memory.get(key) ?? "";
  }
}

export function writeDraft(meId: string, canvasId: string, text: string): void {
  const key = keyOf(meId, canvasId);
  const empty = !text.trim();
  if (empty) memory.delete(key);
  else memory.set(key, text);
  try {
    if (empty) storage()?.removeItem(key);
    else storage()?.setItem(key, text);
  } catch {
    // Full or refused: the copy in memory holds it for now.
  }
  for (const listener of listeners) listener();
}

/** Every draft, of everyone: for signing out. */
export function clearDrafts(): void {
  memory.clear();
  try {
    const store = storage();
    const keys = store ? Object.keys(store).filter((key) => key.startsWith(PREFIX)) : [];
    for (const key of keys) store?.removeItem(key);
  } catch {
    // Refused: there was nothing it would let us keep either.
  }
  for (const listener of listeners) listener();
}

/** The viewer's draft for a canvas, and a setter that keeps it. */
export function useDraft(meId: string, canvasId: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readDraft(meId, canvasId),
  );
  const set = useCallback((next: string) => writeDraft(meId, canvasId, next), [meId, canvasId]);
  return [text, set];
}

/**
 * The draft after a message failed to send: its text back in the field, ahead of anything
 * typed while it was on its way.
 */
export function restoreDraft(unsent: string, typed: string): string {
  return typed.trim() ? `${unsent}\n${typed}` : unsent;
}

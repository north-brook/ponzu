import { useSyncExternalStore } from "react";
import type { ProjectChoice } from "./create";

/*
 * What New canvas holds while it is put down and picked up again, in memory for this run of the
 * app: the project picked in each workspace (the picker is its own screen, and hands its choice
 * back through here), and the prompt being written, kept until it is sent so a send that had
 * to wait, or leaving the screen, never loses it. Nothing here is a secret; signing out forgets
 * it all.
 */

const projects = new Map<string, ProjectChoice>();
let draft = "";
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version += 1;
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The project picked in `workspaceId`, here and in New canvas. */
export function pickProject(workspaceId: string, choice: ProjectChoice): void {
  projects.set(workspaceId, choice);
  emit();
}

/** The project picked in `workspaceId`, if one was. */
export function pickedProject(workspaceId: string | null): ProjectChoice | null {
  return (workspaceId && projects.get(workspaceId)) || null;
}

/** The prompt being written in New canvas. */
export function keepDraft(text: string): void {
  if (text === draft) return;
  draft = text;
  emit();
}

export function currentDraft(): string {
  return draft;
}

/** Forget it all (signing out, or a test starting again). */
export function forgetNewCanvas(): void {
  projects.clear();
  draft = "";
  emit();
}

/** Draw again whenever a pick or the draft changes. */
export function useNewCanvasStore(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

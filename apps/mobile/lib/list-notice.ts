import { useSyncExternalStore } from "react";

/*
 * One quiet line at the top of the canvases list, said by whatever sent the app there: a ping
 * for a canvas the person can't open any more ("That canvas isn't available to you."). It stays
 * until the list is left, then goes (app/(tabs)/(canvases)/canvases.tsx clears it on blur).
 */

let notice: string | null = null;
const listeners = new Set<() => void>();

export function setListNotice(line: string | null): void {
  if (notice === line) return;
  notice = line;
  for (const listener of listeners) listener();
}

export function listNotice(): string | null {
  return notice;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useListNotice(): string | null {
  return useSyncExternalStore(subscribe, listNotice);
}

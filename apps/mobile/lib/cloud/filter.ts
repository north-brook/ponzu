import { type CanvasFilter, NO_FILTER } from "@ponzu/client/model";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import { filterKey, readFilters, withFilter } from "./filter-rules";

/*
 * The canvases list's filter, per person and per workspace (`ponzu.filter.<userId>` in
 * AsyncStorage: a filter for each workspace, by id), so it is there again on the next launch,
 * as the Mac keeps each workspace's. Signing out removes the key with every other `ponzu.*` one.
 */

/** Each person's filters as read or set. Absent until read. */
const kept = new Map<string, Record<string, CanvasFilter>>();
const reading = new Set<string>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the person's kept filters once; one set meanwhile wins over them. */
function read(userId: string) {
  if (kept.has(userId) || reading.has(userId)) return;
  reading.add(userId);
  AsyncStorage.getItem(filterKey(userId))
    .catch(() => null)
    .then((raw) => {
      reading.delete(userId);
      if (kept.has(userId)) return;
      kept.set(userId, readFilters(raw));
      emit();
    });
}

/** Filter `workspaceId`'s canvases for `userId`, here and on the next launch. Best effort on disk. */
export function setFilter(
  userId: string,
  workspaceId: string,
  filter: CanvasFilter,
): Promise<void> {
  const next = withFilter(kept.get(userId) ?? {}, workspaceId, filter);
  kept.set(userId, next);
  emit();
  return AsyncStorage.setItem(filterKey(userId), JSON.stringify(next)).catch(() => {});
}

/** Forget every filter held in memory (signing out, or a test starting again). */
export function forgetFilters(): void {
  kept.clear();
  emit();
}

/** The filter kept for `userId` on `workspaceId`: none until it is read, or with neither. */
export function useKeptFilter(userId: string | null, workspaceId: string | null): CanvasFilter {
  useEffect(() => {
    if (userId) read(userId);
  }, [userId]);
  const snapshot = () => (userId && workspaceId && kept.get(userId)?.[workspaceId]) || NO_FILTER;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

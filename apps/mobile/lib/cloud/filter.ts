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
/** Whose filters have been read from disk, so a write holds every workspace's. */
const read_ = new Set<string>();
const reading = new Set<string>();
/** Filters set before the person's were read, by workspace: laid over what disk held. */
const early = new Map<string, Record<string, CanvasFilter>>();
/** Bumped by `forgetFilters`: a read begun before it (a person signed out since) is dropped. */
let generation = 0;
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

/**
 * Read the person's kept filters once. A workspace's filter set meanwhile wins over what disk held
 * for that workspace; every other workspace's is kept, and the two together are written back.
 */
function read(userId: string) {
  if (read_.has(userId) || reading.has(userId)) return;
  reading.add(userId);
  const began = generation;
  AsyncStorage.getItem(filterKey(userId))
    .catch(() => null)
    .then((raw) => {
      reading.delete(userId);
      if (began !== generation) return;
      read_.add(userId);
      let all = readFilters(raw);
      const set = early.get(userId);
      early.delete(userId);
      if (set) for (const [id, filter] of Object.entries(set)) all = withFilter(all, id, filter);
      kept.set(userId, all);
      emit();
      if (set) void write(userId, all);
    });
}

function write(userId: string, filters: Record<string, CanvasFilter>): Promise<void> {
  return AsyncStorage.setItem(filterKey(userId), JSON.stringify(filters)).catch(() => {});
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
  if (read_.has(userId)) return write(userId, next);
  // Not read yet: held until it is, then written with every other workspace's.
  early.set(userId, { ...early.get(userId), [workspaceId]: filter });
  read(userId);
  return Promise.resolve();
}

/** Forget every filter held in memory (signing out, or a test starting again). */
export function forgetFilters(): void {
  kept.clear();
  read_.clear();
  early.clear();
  generation++;
  emit();
}

/**
 * The filter kept for `userId` on `workspaceId`: undefined until the person's are read (so the
 * list never shows everything first and then narrows), none with no person or workspace.
 */
export function useKeptFilter(
  userId: string | null,
  workspaceId: string | null,
): CanvasFilter | undefined {
  useEffect(() => {
    if (userId) read(userId);
  }, [userId]);
  const snapshot = () => {
    if (!userId || !workspaceId) return NO_FILTER;
    const mine = kept.get(userId);
    return mine ? (mine[workspaceId] ?? NO_FILTER) : undefined;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

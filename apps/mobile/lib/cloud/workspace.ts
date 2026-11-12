import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { pickWorkspace, workspaceKey } from "./workspace-rules";

/*
 * The workspace in view, per person (`ponzu.workspace.<userId>` in AsyncStorage: an id, not a
 * secret). It starts on the first of the person's workspaces, and stays on the one they picked
 * for as long as they belong to it. One choice for the whole app: picking one in Settings moves
 * the canvases list under it at once.
 */

/** Each person's choice as read or made: null for none kept. Absent until it is read. */
const chosen = new Map<string, string | null>();
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

/** Read the person's kept choice once; a choice made meanwhile wins over it. */
function read(userId: string) {
  if (chosen.has(userId) || reading.has(userId)) return;
  reading.add(userId);
  AsyncStorage.getItem(workspaceKey(userId))
    .catch(() => null)
    .then((id) => {
      reading.delete(userId);
      if (chosen.has(userId)) return;
      chosen.set(userId, id);
      emit();
    });
}

/** Show `workspaceId` to `userId` from now on, here and on the next launch. Best effort on disk. */
export function chooseWorkspace(userId: string, workspaceId: string): Promise<void> {
  chosen.set(userId, workspaceId);
  emit();
  return AsyncStorage.setItem(workspaceKey(userId), workspaceId).catch(() => {});
}

/**
 * Show `workspaceId` next time the canvases open, as setting it up from "Where do you build?"
 * does (the Mac opens Fresh start on it the same way). Best effort: the first is the fallback.
 */
export function rememberWorkspace(userId: string, workspaceId: string): Promise<void> {
  return chooseWorkspace(userId, workspaceId);
}

/** Forget every choice held in memory (signing out; the keys on disk go with the rest). */
export function forgetWorkspaces(): void {
  chosen.clear();
  emit();
}

/**
 * The workspace in view for `userId` among `workspaces`, and a way to pick another. Null until
 * the kept choice is read (a moment), and while there are no workspaces.
 */
export function useWorkspaceInView(
  userId: string | null,
  workspaces: readonly { id: string }[] | undefined,
): [string | null, (id: string) => void] {
  useEffect(() => {
    if (userId) read(userId);
  }, [userId]);
  const snapshot = () => (userId && chosen.has(userId) ? (chosen.get(userId) ?? "") : undefined);
  const known = useSyncExternalStore(subscribe, snapshot, snapshot);
  const choose = useCallback(
    (id: string) => {
      if (userId) void chooseWorkspace(userId, id);
    },
    [userId],
  );
  if (!workspaces || known === undefined) return [null, choose];
  return [pickWorkspace(known || null, workspaces), choose];
}

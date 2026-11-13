import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "../cloud/backend";
import { useCloud } from "../cloud/query";
import { type ThreadSnapshot, ThreadStore } from "./thread-store";

const NOTHING: ThreadSnapshot = { items: null, pending: [], older: "none", failed: false };

/**
 * The canvas's thread for the signed-in person while the chat sheet is up: one ThreadStore on
 * their `Live`, closed when the sheet goes or the person changes.
 */
export function useThread(canvasId: string): { store: ThreadStore | null; thread: ThreadSnapshot } {
  const { live, userId } = useCloud();
  const [store, setStore] = useState<ThreadStore | null>(null);
  useEffect(() => {
    if (!userId) return;
    const made = new ThreadStore({ api: backend.api, live, canvasId, meId: userId }).start();
    setStore(made);
    return () => {
      made.close();
      setStore(null);
    };
  }, [canvasId, live, userId]);
  const subscribe = useCallback(
    (changed: () => void) => store?.subscribe(changed) ?? (() => {}),
    [store],
  );
  const thread = useSyncExternalStore(subscribe, () => store?.getSnapshot() ?? NOTHING);
  return { store, thread };
}

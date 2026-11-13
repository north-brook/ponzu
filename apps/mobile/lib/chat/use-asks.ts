import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "../cloud/backend";
import { useCloud } from "../cloud/query";
import { type AskSnapshot, AskStore } from "./ask-store";

const NOTHING: AskSnapshot = { asks: [], open: new Set(), loaded: false, said: null };

/**
 * What the agent waits on in the canvas, for the signed-in person while the chat sheet is up:
 * one AskStore on their `Live`, closed when the sheet goes or the person changes, so nothing of
 * one person's answers is ever shown to the next.
 */
export function useAsks(canvasId: string): { store: AskStore | null; asks: AskSnapshot } {
  const { live, userId } = useCloud();
  const [store, setStore] = useState<AskStore | null>(null);
  useEffect(() => {
    if (!userId) return;
    const made = new AskStore({ api: backend.api, live, canvasId, meId: userId }).start();
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
  const asks = useSyncExternalStore(subscribe, () => store?.getSnapshot() ?? NOTHING);
  return { store, asks };
}

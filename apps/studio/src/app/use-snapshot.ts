import { useSyncExternalStore } from "react";

/** Something that holds a value and says when it changes: the open canvas's stores. */
export interface Store<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

/** A store's value, kept current. */
export function useSnapshot<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

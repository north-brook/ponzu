import { useSyncExternalStore } from "react";

/**
 * A value outside React that screens read with `useStore`. The data layer
 * keeps its state in these, so a socket message or a reach result updates
 * every screen that shows it, and code outside components can read it too.
 */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  set(next: T | ((prev: T) => T)) {
    const value = typeof next === "function" ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.get());
}

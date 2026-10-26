import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

/*
 * Whether the app is in front, for loops nobody can see otherwise: a trace, a shimmer, the
 * slice's juicing, the waveform. Reanimated runs its loops on the UI thread every display frame
 * whether or not the app is on screen, so each holds while this is false (and, in a route, while
 * its screen is under another: use-seen.ts). One AppState listener for all of them.
 */

/** In front: "active", or not yet known. Inactive (the app switcher, a call) and background aren't. */
export function isActive(state: AppStateStatus | string | null | undefined): boolean {
  return state !== "background" && state !== "inactive";
}

let active = isActive(AppState.currentState);
const listeners = new Set<() => void>();
let sub: { remove(): void } | null = null;

function subscribe(l: () => void) {
  listeners.add(l);
  // Nobody listened for a while: what's true now, not what was.
  if (!sub) active = isActive(AppState.currentState);
  sub ??= AppState.addEventListener("change", (s) => {
    const next = isActive(s);
    if (next === active) return;
    active = next;
    for (const fn of listeners) fn();
  });
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      sub?.remove();
      sub = null;
    }
  };
}

/** True while the app is in front. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, () => active);
}

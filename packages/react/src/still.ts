import { useSyncExternalStore } from "react";

/*
 * Whether nobody can be watching the window, so nothing in it should loop: it's hidden
 * (minimized, on another Space, a background tab), or it's out of focus on battery. A design
 * looping behind another app drained a MacBook Air in an afternoon. Plugged in, a window beside
 * the one you're in keeps playing.
 */

interface Battery extends EventTarget {
  charging: boolean;
}

let still = false;
let onBattery = false;
let started = false;
const listeners = new Set<() => void>();

function compute(): boolean {
  return document.visibilityState === "hidden" || (onBattery && !document.hasFocus());
}

function update() {
  const next = compute();
  if (next === still) return;
  still = next;
  for (const l of listeners) l();
}

function start() {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", update);
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  // Chromium only (the desktop app included). Elsewhere it counts as plugged in.
  const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
  nav
    .getBattery?.()
    .then((b) => {
      const read = () => {
        onBattery = !b.charging;
        update();
      };
      read();
      b.addEventListener("chargingchange", read);
    })
    .catch(() => {});
  still = compute();
}

function subscribe(cb: () => void) {
  start();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while the window is hidden, or unfocused on battery: loops should hold. */
export function useWindowStill(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => still,
    () => false,
  );
}

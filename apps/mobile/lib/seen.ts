import type { CatalogFile } from "@ponzu/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Store, useStore } from "./store";

/**
 * When the person last looked at each design on this phone: the design's
 * `modified` when they last opened it. A design changed since shows the
 * yuzu dot on its card and its changes under Activity's New. Designs the
 * phone sees for the first time count as seen, so a fresh install starts
 * clean. Kept on this phone only; syncing it across devices is later work.
 */
const KEY = "ponzu.seen";

/** `<mac>:<key>` → the `modified` the person last saw. */
export const seen = new Store<Record<string, number>>({});
let ready = false;

export async function loadSeen() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) seen.set({ ...(JSON.parse(raw) as Record<string, number>), ...seen.get() });
  } catch {
    // Start clean.
  }
  ready = true;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    AsyncStorage.setItem(KEY, JSON.stringify(seen.get())).catch(() => {});
  }, 500);
}

const id = (mac: string, key: string) => `${mac}:${key}`;

/** The person opened a design as it stood at `modified`. */
export function markSeen(mac: string, key: string, modified: number) {
  const k = id(mac, key);
  if ((seen.get()[k] ?? 0) >= modified) return;
  seen.set((all) => ({ ...all, [k]: modified }));
  save();
}

/** Designs the phone hasn't seen before start as seen. */
export function baselineSeen(mac: string, files: CatalogFile[]) {
  if (!ready) return;
  const all = seen.get();
  let changed = false;
  const next = { ...all };
  for (const f of files) {
    const k = id(mac, f.key);
    if (next[k] === undefined) {
      next[k] = f.modified;
      changed = true;
    }
  }
  if (changed) {
    seen.set(next);
    save();
  }
}

/** Changed since the person last opened it here. */
export function isUnseen(all: Record<string, number>, mac: string, key: string, modified: number) {
  const at = all[id(mac, key)];
  return at !== undefined && modified > at + 1000;
}

export function useSeen() {
  return useStore(seen);
}

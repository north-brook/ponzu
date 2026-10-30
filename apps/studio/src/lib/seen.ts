import type { CatalogFile } from "@ponzu/core";

/**
 * When the person last looked at each design in the app, as the iPhone keeps
 * it (apps/mobile/lib/seen.ts): the design's `modified` as it stood the last
 * time its tab was in front. A design changed since wears the yuzu dot on its
 * card. Designs seen for the first time count as seen, so a fresh install
 * starts clean. By `CatalogFile.id`, in this Mac's localStorage.
 */
export type Seen = Record<string, number>;

const KEY = "ponzu.seen";

export function loadSeen(): Seen {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Seen;
  } catch {
    return {};
  }
}

/** Kept with what another window saved since: each design at the later of the two. */
export function saveSeen(seen: Seen) {
  const saved = loadSeen();
  for (const [id, at] of Object.entries(seen)) saved[id] = Math.max(saved[id] ?? 0, at);
  localStorage.setItem(KEY, JSON.stringify(saved));
}

/**
 * `seen` after a look at `files`: each new design as it stands, and the one
 * in front (`open`, its id) as it stands now. The same object when nothing moved.
 */
export function look(seen: Seen, files: CatalogFile[], open?: string): Seen {
  let next = seen;
  for (const f of files) {
    const at = seen[f.id];
    if (at !== undefined && (f.id !== open || at >= f.modified)) continue;
    if (next === seen) next = { ...seen };
    next[f.id] = f.modified;
  }
  return next;
}

/** Changed since the person last had it in front. */
export function isUnseen(seen: Seen, file: CatalogFile): boolean {
  const at = seen[file.id];
  return at !== undefined && file.modified > at + 1000;
}

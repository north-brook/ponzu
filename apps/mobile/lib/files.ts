import { type Catalog, type CatalogFile, foldCopies } from "@ponzu/core";

/**
 * A design on one of the phone's Macs: the catalog's file, with the Mac it's
 * on and absolute URLs. Pure, so tests run without React Native.
 */
export interface PhoneFile extends CatalogFile {
  /** The saved Mac's id. */
  mac: string;
  macName: string;
  macKind: "laptop" | "desktop";
  /** Its Mac didn't answer this time: shown from the cache, dimmed. */
  stale: boolean;
}

/** One Mac's catalog as the phone holds it. */
export interface MacCatalog {
  catalog: Catalog;
  /** When it last came from the Mac. */
  at: number;
}

export interface MacRef {
  id: string;
  name: string;
  kind: "laptop" | "desktop";
  base: string;
}

/**
 * Every Mac's designs in one list, newest edit first, identical copies folded
 * as on desktop. A Mac's catalog only lists its own designs (the phone asks
 * each Mac itself), so `machine` is always "local" there and the Mac comes
 * from the saved one. Archived designs only show under the Archived shelf.
 */
export function mergeCatalogs(
  macs: MacRef[],
  catalogs: Record<string, MacCatalog | undefined>,
  live: (mac: string) => boolean,
): PhoneFile[] {
  const out: PhoneFile[] = [];
  for (const mac of macs) {
    const c = catalogs[mac.id];
    if (!c) continue;
    const stale = !live(mac.id);
    for (const card of foldCopies(c.catalog.files)) {
      const f = card.file;
      out.push({
        ...f,
        id: `${mac.id}:${f.key}`,
        mac: mac.id,
        macName: mac.name,
        macKind: mac.kind,
        stale,
        preview: f.preview ? mac.base + f.preview : null,
        artboards: f.artboards.map((a) => ({ ...a, thumb: mac.base + a.thumb })),
      });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

export type Shelf = "recent" | "scratch" | "archived";

export function shelfOf(f: CatalogFile): Shelf {
  return f.shelf ?? "recent";
}

/** A project chip: "ponzu", or the designs in no git checkout. */
export interface Project {
  /** The projectName, or null for "Not in a project". */
  name: string | null;
  count: number;
}

/** The project chips for a shelf, biggest first, with "Not in a project" last. */
export function projects(files: PhoneFile[]): Project[] {
  const counts = new Map<string | null, number>();
  for (const f of files) {
    const name = f.git?.projectName ?? null;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) =>
      a.name === null
        ? 1
        : b.name === null
          ? -1
          : b.count - a.count || a.name.localeCompare(b.name),
    );
}

/** The line under a card's name: branch (or folder) and Mac. */
export function whereLine(f: PhoneFile): { branch: string | null; folder: string } {
  const branch = f.git?.branch ?? f.git?.commit ?? null;
  const parts = f.key.split("/").filter(Boolean);
  // The folder a design lives in, without .design: "examples" for examples/kettle.design.
  const folder = parts.length > 1 ? parts[parts.length - 2]! : f.name;
  return { branch, folder };
}

/** "now", "4m", "2h", "1d", or "Oct 14" for anything older than a week. */
export function shortAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(at);
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${month} ${date.getDate()}`;
}

/** "9:12 PM" today, "yesterday", or "Oct 14", for when a Mac last answered. */
export function lastAnswered(at: number | undefined, now = Date.now()): string {
  if (!at) return "Never answered";
  const d = new Date(at);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay)
    return `Last answered at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return "Last answered yesterday";
  return `Last answered ${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
}

/** "6:40 PM", for "as they were at …". */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

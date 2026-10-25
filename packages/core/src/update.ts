import type { CatalogMachine } from "./catalog.ts";

/*
 * Updates across the person's Macs. Each Mac app checks GitHub Releases on its own and downloads
 * in the background (apps/desktop/src/updater.ts). What it has rides on its machine in the
 * catalog, so every Mac's studio sees every Mac's, and one Update in the title bar installs it on
 * all of them, the Mac it was clicked on last (`POST /api/update`). A Mac that was off then
 * catches up by itself once it's back and nobody is using it.
 */

/** A Mac app's updater, as its machine in the catalog carries it. `ponzu serve` has none. */
export interface MachineUpdate {
  /** The Ponzu running. */
  version: string;
  /** A newer Ponzu, downloaded and ready to install, and what's new in it for this Mac. */
  ready?: { version: string; notes: string[] };
  /** Installing, as the person asked: restarting into it, or downloading it first. */
  installing?: boolean;
  /**
   * The agent (its client: claude, openai, …) working on this Mac right now. Its restart waits
   * until the agent is done, so the agent isn't cut off mid-change.
   */
  waitsFor?: string;
}

/** What one click of Update does. */
export interface UpdatePlan {
  /** The newest Ponzu any Mac has downloaded or runs. */
  version: string;
  /** What's new in it, from a Mac that downloaded it: this one when it did. Empty if none has. */
  notes: string[];
  /** The Macs behind it, by machine id: "local" for this one. */
  macs: string[];
  /** Every Mac with an updater, behind or not. */
  of: number;
  /** Whether one of the Macs behind is installing already. */
  installing: boolean;
}

/**
 * The update the title bar offers: the newest Ponzu any of the person's Macs has downloaded or
 * already runs, for every Mac running an older one. Null when they're all on it. A Mac without
 * an updater (`ponzu serve`, an app from before updates spread) isn't counted.
 */
export function updatePlan(machines: CatalogMachine[]): UpdatePlan | null {
  const apps = machines.flatMap((m) => (m.update ? [{ id: m.id, ...m.update }] : []));
  let target: string | null = null;
  for (const a of apps) {
    for (const v of [a.version, a.ready?.version]) {
      if (v && (!target || compareVersions(v, target) > 0)) target = v;
    }
  }
  if (!target) return null;
  const behind = apps.filter((a) => compareVersions(a.version, target) < 0);
  if (!behind.length) return null;
  // This Mac comes first, so its notes win: they start from the version it runs.
  const notes = apps.find((a) => a.ready?.version === target)?.ready?.notes ?? [];
  return {
    version: target,
    notes,
    macs: behind.map((a) => a.id),
    of: apps.length,
    installing: behind.some((a) => a.installing),
  };
}

/** Orders `x.y.z` versions. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

/**
 * What's new, read from a release's changelog when it has no release-notes.json (releases
 * before the app published one): Release Please's list items, HTML as GitHub renders them or
 * Markdown, without their PR and commit links. Only what a Mac on an older Ponzu falls back to.
 */
export function changelogNotes(changelog: string): string[] {
  const items = /<li>/i.test(changelog)
    ? [...changelog.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((m) => m[1]!)
    : changelog
        .split("\n")
        .filter((l) => /^\s*[*-]\s+/.test(l))
        .map((l) => l.replace(/^\s*[*-]\s+/, ""));
  return items
    .map((item) => {
      const text = item
        // A scope, `**desktop:**` or `<strong>desktop:</strong>`, says where, not what.
        .replace(/^\s*<strong>[^<]*:<\/strong>\s*/i, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e]!)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\*\*[^*]+:\*\*\s*/, "")
        .replace(/(\s*\((?:#\d+|[0-9a-f]{7,40})\))+\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return "";
      const cased = /^[a-z]+\b/.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text;
      return /[.!?]$/.test(cased) ? cased : `${cased}.`;
    })
    .filter(Boolean);
}

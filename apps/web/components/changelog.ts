import { z } from "zod";
import { RELEASES } from "./links";
import { FIRST_CLOUD_IPHONE_VERSION, FIRST_CLOUD_VERSION } from "./site";

/*
 * The changelog's notes. Each desktop release publishes changelog.json beside its build, written
 * by `scripts/release-notes.ts --changelog` from main's history (docs/release-notes.md): both
 * apps' releases, each with its tag's date and its pull requests' notes. A Vercel build is a
 * shallow clone, so the site reads that file rather than git.
 *
 * It's read from the latest desktop release only, so an iPhone release shows here once the next
 * desktop release publishes after it.
 */

/** Both apps' notes, beside the latest published desktop release. */
export const CHANGELOG_URL = `${RELEASES}/download/changelog.json`;

/** The app a release is of, as its heading names it. */
export type App = "mac" | "iphone";

const NAME: Record<App, string> = { mac: "Ponzu", iphone: "Ponzu for iPhone" };

const Release = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.iso.datetime({ offset: true }),
  notes: z.array(z.string()),
});

const File = z.object({
  mac: z.array(Release),
  iphone: z.array(Release),
  incomplete: z.literal(true).optional(),
});

/** One release as the page shows it. */
export interface Entry {
  app: App;
  version: string;
  /** ISO 8601, with the offset of whoever tagged it. */
  date: string;
  notes: string[];
}

/** Where each app's changelog starts: Ponzu Cloud's first release of it. */
export const SINCE: Record<App, string> = {
  mac: FIRST_CLOUD_VERSION,
  iphone: FIRST_CLOUD_IPHONE_VERSION,
};

/** Orders `x.y.z` versions (scripts/release-notes.ts has the same, outside the site's build). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The releases a changelog.json holds from `since` on, both apps merged newest first. Null when it
 * isn't the shape the release tooling writes, or says it's incomplete (written from a checkout
 * without history), so the page shows its fallback rather than a wrong or empty list.
 */
export function parseChangelog(data: unknown, since: Record<App, string> = SINCE): Entry[] | null {
  const parsed = File.safeParse(data);
  if (!parsed.success || parsed.data.incomplete) return null;
  const entries = (["mac", "iphone"] as const).flatMap((app) =>
    parsed.data[app]
      .filter((r) => compareVersions(r.version, since[app]) >= 0)
      .map((r) => ({ app, ...r, notes: r.notes.map((n) => n.trim()).filter(Boolean) }))
      .filter((r) => r.notes.length),
  );
  return entries.sort(
    (a, b) =>
      Date.parse(b.date) - Date.parse(a.date) ||
      (a.app === b.app ? compareVersions(b.version, a.version) : a.app === "mac" ? -1 : 1),
  );
}

/**
 * The changelog, or null while GitHub is down, before a release has published the file, or when
 * it's malformed. Never throws: the page falls back to GitHub's releases instead.
 */
export async function latestChangelog(load: typeof fetch = fetch): Promise<Entry[] | null> {
  try {
    const res = await load(CHANGELOG_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseChangelog(await res.json());
  } catch {
    return null;
  }
}

/**
 * A note's text and the `code` its author marked with backticks, in order, so the page can set
 * the code as code. An unpaired backtick is left as text. Everything stays text for React to
 * escape: no other Markdown, and no HTML, is read.
 */
export function noteParts(note: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  let rest = note;
  for (let m = /`([^`]+)`/.exec(rest); m; m = /`([^`]+)`/.exec(rest)) {
    if (m.index) parts.push({ code: false, text: rest.slice(0, m.index) });
    parts.push({ code: true, text: m[1]! });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) parts.push({ code: false, text: rest });
  return parts;
}

/** "Ponzu 2.1.0" or "Ponzu for iPhone 1.0.0". */
export function releaseName(entry: Pick<Entry, "app" | "version">): string {
  return `${NAME[entry.app]} ${entry.version}`;
}

/**
 * The day it was tagged, as people read it: "November 20, 2026". It's the calendar day where the
 * release was tagged (the ISO date's own day), so it never shifts with the server's time zone.
 */
export function releaseDay(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

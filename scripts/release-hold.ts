#!/usr/bin/env bun
/**
 * Whether release.yml's auto-merge job may turn on auto-merge for an app's open release pull
 * request, or must hold it for a person to merge:
 *
 *   bun scripts/release-hold.ts --app <ponzu|mobile> --title "<the pull request's title>"
 *       [--proposed <the pull request's .release-please-manifest.json>]
 *
 * It prints one line, `merge` or `hold: <why>`, and exits 0 either way; a bad flag exits 2 and
 * prints nothing, and the workflow then enables nothing. A release pull request is held when:
 *
 * - the repository variable RELEASES_HELD (a comma-separated list of apps, read here from the
 *   environment variable of the same name) names the app, or names anything that is not an app
 *   (a typo holds every release rather than none);
 * - its title is not exactly the one Release Please writes for that app
 *   (`chore(main): release X.Y.Z`, or `chore(main): release mobile X.Y.Z` for the phone), so a
 *   malformed or unexpected title is held, never merged;
 * - with `--proposed`, the pull request's own manifest does not give the app the title's
 *   version, or cannot be read;
 * - its version is not newer than the app's version in this checkout's
 *   `.release-please-manifest.json`; or
 * - its version is a major bump over that version (2.0.0 over 1.80.1, 1.0.0 over 0.12.1).
 *
 * The checkout's manifest is the released versions: release.yml checks out the commit it runs
 * on, main's head, not the pull request's.
 */
import { readFileSync } from "node:fs";
import manifest from "../.release-please-manifest.json" with { type: "json" };

const VERSION = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;

export const APPS = {
  ponzu: { path: ".", title: new RegExp(`^chore\\(main\\): release ${VERSION}$`) },
  mobile: {
    path: "apps/mobile",
    title: new RegExp(`^chore\\(main\\): release mobile ${VERSION}$`),
  },
} as const;

export type App = keyof typeof APPS;

type Version = [number, number, number];

export type Verdict = { hold: false } | { hold: true; why: string };

function parseVersion(text: unknown): Version | null {
  const match = typeof text === "string" ? new RegExp(`^${VERSION}$`).exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

const isApp = (name: string): name is App => Object.hasOwn(APPS, name);

/** The names RELEASES_HELD lists: comma-separated, any case, spaces ignored. */
export function heldApps(variable: string | undefined): string[] {
  return (variable ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

export function verdict(input: {
  app: App;
  title: string;
  releasesHeld?: string;
  /** The released versions; the checkout's manifest when left out. */
  manifest?: Record<string, unknown>;
  /** The pull request's manifest: null when it could not be read, left out to not check it. */
  proposed?: Record<string, unknown> | null;
}): Verdict {
  const { app, title } = input;
  const held = heldApps(input.releasesHeld);
  if (held.includes(app)) return { hold: true, why: `RELEASES_HELD names ${app}` };
  const unknown = held.filter((name) => !isApp(name));
  if (unknown.length)
    return { hold: true, why: `RELEASES_HELD names ${unknown.join(", ")}, which is no app` };

  const match = APPS[app].title.exec(title);
  if (!match)
    return { hold: true, why: `the title is not a ${app} release title: ${JSON.stringify(title)}` };
  const next: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
  const shown = next.join(".");
  const path = APPS[app].path;

  if (input.proposed !== undefined) {
    const proposed = parseVersion(input.proposed?.[path]);
    if (!proposed || compare(proposed, next) !== 0)
      return {
        hold: true,
        why: `the pull request's manifest gives ${app} ${JSON.stringify(input.proposed?.[path] ?? null)}, not ${shown}`,
      };
  }

  const current = parseVersion((input.manifest ?? (manifest as Record<string, unknown>))[path]);
  if (!current) return { hold: true, why: `the manifest has no version for ${app} (${path})` };
  const was = current.join(".");
  if (compare(next, current) <= 0)
    return { hold: true, why: `${shown} is not newer than ${was}, the version released now` };
  if (next[0] > current[0])
    return { hold: true, why: `${shown} is a major release over ${was}; a person merges it` };
  return { hold: false };
}

/** A manifest file, or null when it is not a JSON object. */
export function readManifest(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const app = arg(argv, "--app");
  const title = arg(argv, "--title");
  const proposed = arg(argv, "--proposed");
  if (!app || !isApp(app) || title === undefined || (argv.includes("--proposed") && !proposed)) {
    console.error(
      'usage: bun scripts/release-hold.ts --app <ponzu|mobile> --title "<title>" [--proposed <manifest.json>]',
    );
    process.exit(2);
  }
  const answer = verdict({
    app,
    title,
    releasesHeld: process.env.RELEASES_HELD,
    ...(proposed ? { proposed: readManifest(proposed) } : {}),
  });
  // One line, whatever the title holds.
  console.log(answer.hold ? `hold: ${answer.why.replace(/[\r\n]+/g, " ")}` : "merge");
}

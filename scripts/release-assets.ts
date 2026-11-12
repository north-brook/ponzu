#!/usr/bin/env bun
/**
 * Whether a desktop release has everything it promises, before it's published. Every computer
 * updates from its platform's feed and the site links each platform's download by a name that
 * never changes, so a release that lacks any of them, or carries a file other than the one its
 * feed describes, isn't published at all (CONTRIBUTING.md#releases).
 *
 *   bun scripts/release-assets.ts <dir> <version> [mac] [windows] [linux]
 *       check the release of <version>'s files, downloaded into <dir>, for those platforms (all
 *       three when none is named): each feed is there and names <version>, each file it names
 *       is there with its size and sha512, and so are the downloads, which the feed names too,
 *       and release-notes.json. changelog.json, which the site's /changelog reads, is checked
 *       when it's there: a release built before the publish job wrote it still passes.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Platform = "mac" | "windows" | "linux";

/** Each platform's update feed and the downloads the site links to (…/releases/latest/download/<name>). */
export const PLATFORMS: Record<Platform, { feed: string; downloads: string[] }> = {
  mac: { feed: "latest-mac.yml", downloads: ["Ponzu-arm64.dmg"] },
  windows: { feed: "latest.yml", downloads: ["Ponzu-x64.exe"] },
  linux: { feed: "latest-linux.yml", downloads: ["Ponzu-x64.AppImage", "Ponzu-x64.deb"] },
};

/** What every app about to update reads beside the build (docs/release-notes.md). */
export const NOTES = "release-notes.json";

/** Both apps' dated notes, which the site's /changelog reads (scripts/release-notes.ts --changelog). */
export const CHANGELOG = "changelog.json";

const VERSION = /^\d+\.\d+\.\d+$/;
/** `git log --format=%cI`'s date with its offset, the only date the site accepts (zod's iso.datetime). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** What's wrong with a changelog.json's text: nothing when the site can read it. */
export function changelogProblems(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [`${CHANGELOG} isn't JSON`];
  }
  if (!data || typeof data !== "object") return [`${CHANGELOG} isn't an object`];
  const out: string[] = [];
  const { incomplete } = data as { incomplete?: unknown };
  if (incomplete !== undefined && incomplete !== true)
    out.push(`${CHANGELOG}'s incomplete is neither true nor left out`);
  for (const app of ["mac", "iphone"] as const) {
    const list = (data as Record<string, unknown>)[app];
    if (!Array.isArray(list)) {
      out.push(`${CHANGELOG} has no ${app} list`);
      continue;
    }
    list.forEach((entry, i) => {
      const r = (entry ?? {}) as { version?: unknown; date?: unknown; notes?: unknown };
      const ok =
        typeof r.version === "string" &&
        VERSION.test(r.version) &&
        typeof r.date === "string" &&
        ISO_DATE.test(r.date) &&
        !Number.isNaN(Date.parse(r.date)) &&
        Array.isArray(r.notes) &&
        r.notes.every((n) => typeof n === "string");
      if (!ok) out.push(`${CHANGELOG}'s ${app} release ${i + 1} isn't a version, date and notes`);
    });
  }
  return out;
}

export interface File {
  size: number;
  /** Base64, as electron-builder's feeds carry it. */
  sha512: string;
}

interface Feed {
  version?: unknown;
  path?: unknown;
  files?: { url?: unknown; size?: unknown; sha512?: unknown }[];
}

/** What's wrong with a release's files for `platforms`: nothing when it can be published. */
export function problems(
  version: string,
  platforms: Platform[],
  feeds: Record<string, string>,
  files: Map<string, File>,
  changelog?: string,
): string[] {
  const out: string[] = [];
  const need = (name: string) => {
    if (!files.has(name)) out.push(`${name} is missing`);
  };
  for (const platform of platforms) {
    const { feed: name, downloads } = PLATFORMS[platform];
    downloads.forEach(need);
    const text = feeds[name];
    if (text === undefined) {
      out.push(`${name} is missing`);
      continue;
    }
    let feed: Feed;
    try {
      feed = Bun.YAML.parse(text) as Feed;
    } catch {
      out.push(`${name} isn't YAML`);
      continue;
    }
    if (String(feed.version) !== version)
      out.push(`${name} is for ${String(feed.version)}, not ${version}`);
    const listed = feed.files ?? [];
    if (!listed.length) out.push(`${name} names no files`);
    for (const f of listed) {
      const url = String(f.url);
      const file = files.get(url);
      if (!file) out.push(`${url}, in ${name}, is missing`);
      else if (file.size !== f.size || file.sha512 !== f.sha512)
        out.push(`${url} isn't the file ${name} describes`);
    }
    // Older updaters read `path`: it must be one of the files checked above.
    if (feed.path !== undefined && !listed.some((f) => f.url === feed.path))
      out.push(`${name}'s path, ${String(feed.path)}, isn't one of its files`);
    // The installed app updates from the same file: one its feed doesn't name never updates.
    for (const download of downloads)
      if (!listed.some((f) => f.url === download))
        out.push(`${download} isn't in ${name}, so nothing installed from it updates`);
  }
  need(NOTES);
  if (changelog !== undefined) out.push(...changelogProblems(changelog));
  return out;
}

async function sha512(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

if (import.meta.main) {
  const [dir, version, ...named] = process.argv.slice(2);
  const unknown = named.filter((p) => !(p in PLATFORMS));
  if (!dir || !version || unknown.length) {
    console.error("usage: bun scripts/release-assets.ts <dir> <version> [mac] [windows] [linux]");
    process.exit(2);
  }
  const platforms = (named.length ? named : Object.keys(PLATFORMS)) as Platform[];
  const files = new Map<string, File>();
  const feeds: Record<string, string> = {};
  let changelog: string | undefined;
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    files.set(name, { size: statSync(path).size, sha512: await sha512(path) });
    if (name.endsWith(".yml")) feeds[name] = readFileSync(path, "utf8");
    if (name === CHANGELOG) changelog = readFileSync(path, "utf8");
  }
  const found = problems(version, platforms, feeds, files, changelog);
  for (const p of found) console.error(`::error::${p}`);
  if (found.length) process.exit(1);
  console.log(`Ponzu ${version} has every file for ${platforms.join(", ")}:`);
  for (const [name, { size }] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    console.log(`  ${name} (${size} bytes)`);
}

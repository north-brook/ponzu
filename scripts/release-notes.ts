#!/usr/bin/env bun
/**
 * Release notes are written by the pull request's author under a
 * `## Release note` heading in its description. The squash merge copies the
 * description into the commit message, so the notes travel with the commit.
 * The desktop build reads them back out of main's history, grouped by the
 * release tag that shipped them, and bundles them for What's new
 * (docs/release-notes.md).
 *
 *   bun scripts/release-notes.ts <out.json>
 *       write `{ "releases": [{ version, notes }] }`, newest first
 *
 * A checkout without history or tags (CI's shallow clone) writes no releases
 * and warns instead of failing: the build still works, it just has nothing
 * to show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

export interface Release {
  version: string;
  notes: string[];
}

const HEADING = /^#{2,3}\s+release notes?\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+/;
const COMMENT = /<!--[\s\S]*?-->/g;
const NOTHING = /^(none|n\/a|-|no)\.?$/i;
/** A git trailer, which names people (and their email) rather than a change. */
const TRAILER = /^(?:[a-z][\w-]*-by|cc):\s/i;
/** A tool's sign-off line at the foot of a description, such as "🤖 Generated with …". */
const SIGN_OFF = /^\W*generated (with|by)\b/i;
/** A first word in lowercase only, so `macOS` or `iPhone` keeps its case. */
const LOWERCASE_WORD = /^[a-z]+\b/;
const RELEASE_COMMIT = /^chore\(main\): release /;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The user-facing lines a commit message or pull request description carries. */
export function extractNotes(message: string): string[] {
  const lines = message.replace(COMMENT, "").split("\n");
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start === -1) return [];
  const notes: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text && !NOTHING.test(text)) {
      notes.push(LOWERCASE_WORD.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text);
    }
  };
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    // The section ends at the next heading, a tool's sign-off (never a
    // bullet), or the trailers git adds.
    const signOff = !BULLET.test(line) && SIGN_OFF.test(line);
    if (ANY_HEADING.test(line) || TRAILER.test(line) || signOff) break;
    if (BULLET.test(line)) {
      flush();
      paragraph.push(line.replace(BULLET, ""));
    } else if (line) {
      paragraph.push(line);
    } else {
      flush();
    }
  }
  flush();
  return notes;
}

/** Orders `x.y.z` versions; anything unparsable sorts first. */
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
 * Every `vX.Y.Z` tag with the notes of the commits main gained up to it since
 * the tag before, newest first. Commits after the newest tag haven't shipped
 * and are left out; a release with nothing to say is omitted.
 */
export async function releases(cwd = process.cwd()): Promise<Release[]> {
  const tags = (await $`git tag --list ${"v*"}`.cwd(cwd).quiet().text())
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => TAG.test(tag))
    .sort(compareVersions);
  const out: Release[] = [];
  let previous: string | null = null;
  for (const tag of tags) {
    const range = previous ? `${previous}..${tag}` : tag;
    previous = tag;
    // A record separator between commits, a unit separator between fields.
    const log = await $`git log --reverse --first-parent --format=${"%s%x1f%B%x1e"} ${range}`
      .cwd(cwd)
      .quiet()
      .text();
    const notes = log
      .split("\x1e")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const [subject = "", message = ""] = entry.split("\x1f");
        return RELEASE_COMMIT.test(subject) ? [] : extractNotes(message);
      });
    if (notes.length) out.push({ version: tag.slice(1), notes });
  }
  return out.reverse();
}

if (import.meta.main) {
  const [path] = process.argv.slice(2);
  if (!path) {
    console.error("usage: bun scripts/release-notes.ts <out.json>");
    process.exit(1);
  }
  let found: Release[] = [];
  try {
    const shallow = (await $`git rev-parse --is-shallow-repository`.quiet().text()).trim();
    if (shallow === "true") throw new Error("shallow checkout");
    found = await releases();
    if (!found.length) console.warn("release-notes: no tagged release has notes");
  } catch (err) {
    console.warn(`release-notes: bundling none (${err instanceof Error ? err.message : err})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ releases: found }, null, 2)}\n`);
  console.log(`release-notes: ${found.length} releases → ${path}`);
}

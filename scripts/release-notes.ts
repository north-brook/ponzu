#!/usr/bin/env bun
/**
 * Release notes are written by the pull request's author under a
 * `## Release note` heading in its description. The squash merge copies the
 * description into the commit message, so the notes travel with the commit.
 * This reads them back out of main's history, grouped by the release tag that
 * shipped them (docs/release-notes.md), for either app:
 *
 *   bun scripts/release-notes.ts <out.json>
 *       the desktop app's (`vX.Y.Z`): write `{ "releases": [{ version, notes }] }`,
 *       newest first, which the release publishes beside its build for the
 *       title bar's update popover. `iPhone:` notes are left out, and `Mac:`
 *       ones keep their words without the label.
 *   bun scripts/release-notes.ts --phone <mobile-vX.Y.Z>
 *       the iPhone app's: print that release's notes, one `- ` line each, for
 *       TestFlight's What to Test (apps/mobile/.eas/workflows/production.yml).
 *       Its notes are the `iPhone:` ones and those without a label from
 *       commits that changed only `apps/mobile`; nothing if it has none.
 *   bun scripts/release-notes.ts --changelog <out.json>
 *       both apps' releases with the date of each tag's commit, for the site's
 *       /changelog: `{ "mac": [{ version, date, notes }], "iphone": [...] }`,
 *       each newest first. The publish job puts it beside each desktop
 *       release as `changelog.json`, so the iPhone's newest releases reach the
 *       site with the desktop's next one.
 *
 * A checkout without history or tags (CI's shallow clone) finds no releases
 * and warns instead of failing, so whatever reads the notes still works with
 * nothing to show. The desktop's file and the changelog are marked
 * `"incomplete": true`, so an app about to update (or the site) doesn't take
 * the empty list for every release's notes; the phone's prints nothing, and
 * its workflow falls back to its own line.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

export interface Release {
  version: string;
  notes: string[];
}

/** A release with the date its tag's commit was made, as the site's changelog shows it. */
export interface DatedRelease extends Release {
  /** ISO 8601 with the committer's offset, from `git log -1 --format=%cI <tag>`. */
  date: string;
}

/** What the site's /changelog reads: each app's releases, newest first. */
export interface Changelog {
  mac: DatedRelease[];
  iphone: DatedRelease[];
  /** Set when the history couldn't be read, so the lists are empty rather than complete. */
  incomplete?: true;
}

/** The desktop app (Mac, Windows, Linux) or the iPhone app, which release apart. */
export type App = "mac" | "iphone";

const HEADING = /^#{2,3}\s+release notes?\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+/;
const COMMENT = /<!--[\s\S]*?-->/g;
const NOTHING = /^(none|n\/a|-|no)\.?$/i;
/** A git trailer, which names people (and their email) rather than a change. */
const TRAILER = /^(?:[a-z][\w-]*-by|cc):\s/i;
/** A tool's sign-off line at the foot of a description, such as "🤖 Generated with …". */
const SIGN_OFF = /^\W*generated (with|by)\b/i;
/** A note about the phone only, in a pull request that also changed the Mac. */
const IPHONE = /^iphone:\s*/i;
/** A note about the Mac only, in a pull request that also changed the phone. */
const MAC = /^mac:\s*/i;
/** A first word in lowercase only, so `macOS` or `iPhone` keeps its case. */
const LOWERCASE_WORD = /^[a-z]+\b/;
const RELEASE_COMMIT = /^chore\(main\): release /;
/** Each app's release tags: the version is the numbers after the prefix. */
const TAGS: Record<App, { glob: string; pattern: RegExp }> = {
  mac: { glob: "v*", pattern: /^v(\d+\.\d+\.\d+)$/ },
  iphone: { glob: "mobile-v*", pattern: /^mobile-v(\d+\.\d+\.\d+)$/ },
};
/** The most TestFlight's What to Test takes; Apple refuses a longer one. */
export const WHAT_TO_TEST_LIMIT = 4000;

/**
 * One app's user-facing lines a commit message or pull request description
 * carries: those labelled for it, without the label, and, if `unlabelled`,
 * those with no label. A note with no label is the desktop's unless its
 * commit changed only the phone, so the phone's are asked for by commit.
 */
export function extractNotes(message: string, app: App = "mac", unlabelled = true): string[] {
  const [own, other] = app === "mac" ? [MAC, IPHONE] : [IPHONE, MAC];
  const lines = message.replace(COMMENT, "").split("\n");
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start === -1) return [];
  const notes: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const joined = paragraph.join(" ").trim();
    paragraph = [];
    if (other.test(joined) || (!unlabelled && !own.test(joined))) return;
    const text = joined.replace(own, "");
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
    } else if (raw === raw.trimStart() && (IPHONE.test(line) || MAC.test(line))) {
      // A labelled line is a note of its own even without a bullet, so an
      // iPhone note never runs on into the Mac's above it. Indented, it's a
      // wrapped line of the note above.
      flush();
      paragraph.push(line);
    } else if (line) {
      paragraph.push(line);
    } else {
      flush();
    }
  }
  flush();
  return notes;
}

/**
 * A commit that changed only the phone app, which ships on its own tags
 * (mobile-vX.Y.Z). Release Please leaves it out of the Mac's release too
 * (`exclude-paths` in release-please-config.json).
 */
export function phoneOnly(files: string[]): boolean {
  return files.length > 0 && files.every((file) => file.startsWith("apps/mobile/"));
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
 * Every release tag of `app` with its notes from the commits main gained up to
 * it since the tag before, newest first. Commits after the newest tag haven't
 * shipped and are left out; a release with nothing to say is omitted.
 */
export async function releases(cwd = process.cwd(), app: App = "mac"): Promise<Release[]> {
  const { glob, pattern } = TAGS[app];
  const tags = (await $`git tag --list ${glob}`.cwd(cwd).quiet().text())
    .split("\n")
    .map((tag) => tag.trim())
    .flatMap((tag) => {
      const version = pattern.exec(tag)?.[1];
      return version ? [{ tag, version }] : [];
    })
    .sort((a, b) => compareVersions(a.version, b.version));
  const out: Release[] = [];
  let previous: string | null = null;
  for (const { tag, version } of tags) {
    const range = previous ? `${previous}..${tag}` : tag;
    previous = tag;
    // A record separator before each commit, a unit separator between its
    // subject and message, and a group separator before the files it changed.
    const log =
      await $`git log --reverse --first-parent --name-only --format=${"%x1e%s%x1f%B%x1d"} ${range}`
        .cwd(cwd)
        .quiet()
        .text();
    const notes = log
      .split("\x1e")
      .filter((entry) => entry.trim())
      .flatMap((entry) => {
        const [head = "", list = ""] = entry.split("\x1d");
        const [subject = "", message = ""] = head.split("\x1f");
        const files = list.split("\n").filter(Boolean);
        if (RELEASE_COMMIT.test(subject)) return [];
        if (app === "iphone") return extractNotes(message, app, phoneOnly(files));
        return phoneOnly(files) ? [] : extractNotes(message);
      });
    if (notes.length) out.push({ version, notes });
  }
  return out.reverse();
}

/** The ISO date of the commit `tag` points at. */
export async function tagDate(cwd: string, tag: string): Promise<string> {
  return (await $`git log -1 --format=%cI ${tag}`.cwd(cwd).quiet().text()).trim();
}

/** Both apps' releases with their tags' dates: the desktop's `vX.Y.Z`, the phone's `mobile-vX.Y.Z`. */
export async function changelog(cwd = process.cwd()): Promise<Changelog> {
  const dated = async (app: App, prefix: string) =>
    Promise.all(
      (await releases(cwd, app)).map(async (r) => ({
        version: r.version,
        date: await tagDate(cwd, `${prefix}${r.version}`),
        notes: r.notes,
      })),
    );
  return { mac: await dated("mac", "v"), iphone: await dated("iphone", "mobile-v") };
}

/** A release's notes as TestFlight's What to Test, leaving out whole notes past Apple's limit. */
export function whatToTest(notes: string[]): string {
  let text = "";
  for (const note of notes) {
    const next = text ? `${text}\n- ${note}` : `- ${note}`;
    if (next.length > WHAT_TO_TEST_LIMIT) break;
    text = next;
  }
  return text;
}

/** Throws in a checkout without history, whose releases would be wrong rather than empty. */
async function assertHistory() {
  const shallow = (await $`git rev-parse --is-shallow-repository`.quiet().text()).trim();
  if (shallow === "true") throw new Error("shallow checkout");
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--phone") {
    const tag = args[1] ?? "";
    const version = TAGS.iphone.pattern.exec(tag)?.[1];
    if (!version) {
      console.error("usage: bun scripts/release-notes.ts --phone <mobile-vX.Y.Z>");
      process.exit(1);
    }
    // Only the notes go to stdout, which the workflow reads.
    try {
      await assertHistory();
      const release = (await releases(process.cwd(), "iphone")).find((r) => r.version === version);
      if (release) console.log(whatToTest(release.notes));
      else console.warn(`release-notes: ${tag} has no notes`);
    } catch (err) {
      console.warn(`release-notes: none for ${tag} (${describe(err)})`);
    }
  } else if (args[0] === "--changelog") {
    const path = args[1];
    if (!path) {
      console.error("usage: bun scripts/release-notes.ts --changelog <out.json>");
      process.exit(1);
    }
    let out: Changelog;
    try {
      await assertHistory();
      out = await changelog();
    } catch (err) {
      out = { mac: [], iphone: [], incomplete: true };
      console.warn(`release-notes: changelog has none (${describe(err)})`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
    console.log(
      `release-notes: ${out.mac.length} desktop and ${out.iphone.length} iPhone releases → ${path}`,
    );
  } else {
    const [path] = args;
    if (!path) {
      console.error("usage: bun scripts/release-notes.ts <out.json>");
      process.exit(1);
    }
    let found: Release[] = [];
    let incomplete = false;
    try {
      await assertHistory();
      found = await releases();
      if (!found.length) console.warn("release-notes: no tagged release has notes");
    } catch (err) {
      incomplete = true;
      console.warn(`release-notes: bundling none (${describe(err)})`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ releases: found, ...(incomplete ? { incomplete } : {}) }, null, 2)}\n`,
    );
    console.log(`release-notes: ${found.length} releases → ${path}`);
  }
}

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type CatalogArtboard,
  type CatalogFile,
  type CatalogGit,
  type CatalogShelf,
  type Doc,
  hashedId,
  parseArtboardFile,
} from "@ponzu/core";
import { archivedAt, CatalogDb, type DesignRow, type FoundBy, type Shelf } from "./catalog-db.ts";
import { PREVIEW_FILE, PREVIEW_VERSION, previewCurrent } from "./preview.ts";

/** How often designs are looked for in the background. */
const DISCOVER_EVERY = 30_000;
/** How long a design's last-edit time stays fresh: the home screen polls. */
const EDIT_TTL = 3_000;
/** How long a design's git checkout and branch stay fresh. */
const GIT_TTL = 10_000;
/** How long a design whose folder is gone is remembered, in case it comes back. */
const FORGET_AFTER = 30 * 24 * 60 * 60 * 1000;
/** How deep a known checkout is walked for designs Spotlight can't see. */
const CHECKOUT_DEPTH = 4;

/** Where to look without Spotlight, a few levels deep. */
const FALLBACK_DIRS = ["code", "src", "git", "Projects", "dev", "Developer"];

/**
 * Folders macOS guards with a privacy prompt. Reading one for the first time
 * stops on "Ponzu would like to access files in your … folder" until someone
 * answers. Designs in them are listed from Spotlight's index without reading
 * them, until the person opens one there: that read asks, at a moment the
 * prompt makes sense, and once allowed the folder's designs show in full.
 */
const GUARDED = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"];

export interface CatalogOptions {
  /** Folders always scanned (the server's cwd, for one). */
  roots?: string[];
  /**
   * How to find designs beyond the roots: Spotlight (the default on macOS), a
   * walk of the usual folders (`false`, and the fallback when Spotlight can't
   * answer), or nothing more ("roots").
   */
  spotlight?: boolean | "roots";
  /**
   * Where the catalog remembers what it found and what the person did with it
   * (~/.ponzu/ponzu.db). Without one it remembers for this run only.
   */
  dbFile?: string;
  /**
   * The JSON file older versions kept, read once into the database. It's kept
   * up to date for a few releases, so going back a version still finds the
   * folders the person let Ponzu read.
   */
  stateFile?: string;
}

/** A design as the home screen lists it, read from disk without opening it. */
export interface CatalogSummary {
  key: string;
  name: string;
  modified: number;
  /** In a guarded folder Ponzu hasn't been let into yet: listed by name only. */
  locked: boolean;
  /** When the canvas preview was drawn, or null without one. */
  previewAt: number | null;
  /** design.json says `"example": true`. */
  example: boolean;
  /** design.json says `"scratch": true`. */
  scratch: boolean;
  /** The view it's listed in, after the person's say. */
  shelf: CatalogShelf;
  /** When the person archived it, if it's archived. */
  archived?: number;
  /** The git checkout it's in, if any. */
  git?: CatalogGit;
  pages: CatalogFile["pages"];
  artboards: Omit<CatalogArtboard, "thumb">[];
}

/**
 * Every .design on this Mac, newest edit first, from the database of every
 * design Ponzu has found. Finding them runs in the background, so listing
 * never waits on it: Spotlight finds them anywhere it indexes, a shallow walk
 * of the usual folders stands in without it (Linux, an unindexed disk), and
 * each git checkout a design was found in is walked, hidden folders and all,
 * since Spotlight skips those (a worktree under ~/.t3, a `.context` folder).
 *
 * Example designs (`"example": true` in design.json, like the ones in Ponzu's
 * repo, which every checkout of it carries) are listed only once the person
 * opens one: see `opened`. Being found, or opened for an agent, doesn't list
 * them. A design in a guarded folder Ponzu can't read yet can't say it's an
 * example, so it's listed by name like any other.
 */
export class LocalCatalog {
  readonly db: CatalogDb;
  private discovering: Promise<void> | null = null;
  private discoveredAt = 0;
  private dataVersion = -1;
  private rows = new Map<string, DesignRow>();
  private edits = new Map<string, { at: number; modified: number }>();
  private summaries = new Map<string, { modified: number; summary: CatalogSummary | null }>();
  private gits = new Map<string, { at: number; git: CatalogGit | null }>();
  private granted: Set<string>;
  /** Designs the person opened while this runs, by key and by real path. */
  private shown = new Set<string>();
  /** Spotlight's last-change times, for designs it can't be let into yet. */
  private indexed = new Map<string, number>();
  /** Opened or created here, so readable and listed whatever the database says. */
  private extra = new Set<string>();
  /** The path each design was found at, by its real path: listed under the path it was found at. */
  private foundAt = new Map<string, string>();

  constructor(private opts: CatalogOptions = {}) {
    this.db = new CatalogDb(opts.dbFile);
    this.importState();
    this.granted = new Set(this.db.grants());
  }

  /**
   * A design this server opened or created. It's listed straight away, and
   * opening it read it, so its folder is readable.
   */
  add(key: string, by: FoundBy = "opened"): void {
    this.extra.add(key);
    this.db.seen([[realpathOr(key), by]]);
    this.grantFor(key);
  }

  /**
   * The person opened this design themselves, so it's listed even if it's an
   * example, and out of the archive if it was in it. `remember` keeps an
   * example listed after a restart, as opening it in the app does; the designs
   * named to `ponzu serve` are listed while it runs.
   */
  opened(key: string, opts: { remember?: boolean } = {}): void {
    this.add(key);
    // They just opened it, so its folder is readable and resolving it asks nothing.
    const real = realpathOr(key);
    this.shown.add(key);
    this.shown.add(real);
    this.db.revive(real);
    if (opts.remember) this.db.opened(real);
  }

  /** An agent changed it through Ponzu's tools: out of the archive, if it was in it. */
  edited(key: string): void {
    const real = realpathOr(key);
    // Read fresh: another process may have archived it since this one last listed.
    if (archivedAt(this.db.get(real))) this.db.revive(real);
  }

  archive(key: string): void {
    this.db.archive(realpathOr(key));
  }

  restore(key: string): void {
    this.db.revive(realpathOr(key));
  }

  /** The person's say on where it's listed: Recent or Scratch, or (null) what its file says. */
  shelve(key: string, shelf: Shelf | null): void {
    this.db.shelve(realpathOr(key), shelf);
  }

  /** Whether a design is listed here, so its preview, thumbnails and assets may be served. */
  async has(key: string): Promise<boolean> {
    await this.ready();
    if (this.extra.has(key)) return true;
    const row = this.row(this.readable(key) ? realpathOr(key) : key);
    return Boolean(row && row.missing_since === null);
  }

  /** Whether reading this design can't stop on a privacy prompt. */
  readable(key: string): boolean {
    const guard = guardOf(key);
    return !guard || this.granted.has(guard);
  }

  /**
   * Every design here, newest edit first. Open designs pass their live doc, so
   * an edit shows before it reaches the disk. Listing never reads inside a
   * guarded folder Ponzu hasn't been let into: only opening a design does.
   */
  async files(open: Map<string, Doc>): Promise<CatalogSummary[]> {
    await this.ready();
    this.refresh();
    // One entry per folder, however it was reached (/tmp is /private/tmp, a symlinked
    // project, …). The database knows it by its real path; it's listed by the path it was
    // opened at, else found at, and an open design's own key wins, so its card opens the
    // same socket.
    const byReal = new Map<string, { key: string; rank: number }>();
    const known = [...this.rows.values()]
      .filter((r) => r.missing_since === null)
      .map((r) => r.path);
    for (const [k, rank, row] of [
      ...known.map((k) => [this.foundAt.get(k) ?? k, 0, k] as const),
      ...[...this.extra].map((k) => [k, 1, null] as const),
      ...[...open.keys()].map((k) => [k, 2, null] as const),
    ]) {
      // A row's path is already real. Resolving a path inside a guarded folder touches it
      // too; those keep the path Spotlight gave.
      const real = row ?? (this.readable(k) ? await realpath(k).catch(() => k) : k);
      const had = byReal.get(real);
      if (!had || rank > had.rank) byReal.set(real, { key: k, rank });
    }
    const out: CatalogSummary[] = [];
    const gone: string[] = [];
    await Promise.all(
      [...byReal].map(async ([real, { key }]) => {
        const doc = open.get(key);
        const row = this.row(real);
        if (!doc && !this.readable(key)) {
          out.push(lockedSummary(key, this.indexed.get(key) ?? 0, this.shelfOf(row, false)));
          return;
        }
        const s = await this.summary(key);
        if (!s) {
          if (!doc && !this.extra.has(key)) gone.push(real);
          return;
        }
        const example = doc ? Boolean(doc.example) : s.example;
        const opened = this.shown.has(key) || this.shown.has(real) || Boolean(row?.opened_at);
        if (example && !opened) return;
        const scratch = doc ? Boolean(doc.scratch) : s.scratch;
        // One from an older version counts as none: the server redraws it when asked.
        const [previewAt, git] = await Promise.all([
          previewCurrent(key).then((current) =>
            current
              ? stat(join(key, PREVIEW_FILE)).then(
                  (st) => st.mtimeMs,
                  () => null,
                )
              : null,
          ),
          this.git(key),
        ]);
        const archived = archivedAt(row);
        const listed: CatalogSummary = {
          ...s,
          scratch,
          shelf: this.shelfOf(row, scratch),
          ...(archived ? { archived } : {}),
          previewAt,
          ...(git ? { git } : {}),
        };
        out.push(doc ? { ...listed, ...fromDoc(doc) } : listed);
      }),
    );
    // Gone since it was found, like a deleted worktree's: hidden now, forgotten in a while.
    if (gone.length) this.db.missing(gone);
    return out.sort((a, b) => b.modified - a.modified);
  }

  /** Look for designs now, and wait until it's done. */
  async rescan(): Promise<void> {
    this.discoveredAt = 0;
    await this.ready();
    await this.discovering;
  }

  /** Stop looking for designs, and let go of the database. */
  close(): void {
    this.db.close();
  }

  private shelfOf(row: DesignRow | undefined, scratch: boolean): CatalogShelf {
    if (archivedAt(row)) return "archived";
    if (row?.shelf) return row.shelf;
    return scratch ? "scratch" : "recent";
  }

  private row(path: string): DesignRow | undefined {
    return this.rows.get(path);
  }

  /** The database as of now: re-read only when another process (or this one) wrote to it. */
  private refresh(): void {
    const v = this.db.dataVersion();
    if (v === this.dataVersion && v !== -1) return;
    this.dataVersion = v;
    this.rows = new Map(this.db.all().map((r) => [r.path, r]));
    for (const g of this.db.grants()) this.granted.add(g);
  }

  /**
   * Discovery runs in the background on a timer. A listing waits for it only
   * until it has finished once on this Mac, a fresh install, so the home
   * screen doesn't start out with just the designs open now.
   */
  private async ready(): Promise<void> {
    const stale = Date.now() - this.discoveredAt > DISCOVER_EVERY;
    if (stale && !this.discovering) {
      this.discoveredAt = Date.now();
      this.discovering = this.discover().finally(() => {
        this.discovering = null;
      });
    }
    if (this.discovering && !this.db.meta("discovered")) await this.discovering;
    this.refresh();
  }

  /** Look for designs everywhere this catalog looks, and remember what it found. */
  private async discover(): Promise<void> {
    const roots = this.opts.roots ?? [];
    const useSpotlight = this.opts.spotlight ?? process.platform === "darwin";
    const found = new Map<string, FoundBy>();
    const spotlight = useSpotlight === true ? await mdfind() : null;
    if (spotlight)
      for (const [k, t] of spotlight) {
        found.set(k, "spotlight");
        this.indexed.set(k, t);
      }
    // Without Spotlight, walk the usual folders. An empty answer counts as none: with
    // indexing off, mdfind succeeds and finds nothing. Never the guarded folders: walking
    // one would ask for access before there's any reason to.
    const dirs =
      spotlight?.size || useSpotlight === "roots"
        ? roots
        : [...roots, ...FALLBACK_DIRS.map((d) => join(homedir(), d))];
    // `${dir}/` so a guarded folder counts as inside itself.
    const enter = (dir: string) => this.readable(`${dir}/`);
    for (const dir of dirs) for (const k of await walk(dir, 4, enter)) found.set(k, "walk");
    // Every checkout of every repository a design is known in, worktrees included, and
    // hidden folders and all: Spotlight skips them.
    const known = [...found.keys(), ...this.db.all().map((r) => r.path)];
    const repos = new Set<string>();
    for (const k of known) {
      if (!this.readable(k)) continue;
      const git = await this.git(k);
      if (git) repos.add(git.root);
    }
    const checkouts = new Set<string>();
    for (const root of repos) for (const c of await checkoutsOf(root)) checkouts.add(c);
    for (const dir of checkouts)
      for (const k of await walk(dir, CHECKOUT_DEPTH, enter, { hidden: true }))
        if (!found.has(k)) found.set(k, "walk");
    const listed = [...found].filter(([k]) => isListed(k));
    // Resolved so the same folder reached two ways is one row; never inside a guarded folder.
    const rows: [string, FoundBy][] = await Promise.all(
      listed.map(async ([k, by]) => {
        const real = this.readable(k) ? await realpath(k).catch(() => k) : k;
        if (real !== k) this.foundAt.set(real, k);
        return [real, by] as [string, FoundBy];
      }),
    );
    this.db.seen(rows);
    this.db.forget(Date.now() - FORGET_AFTER);
    this.db.setMeta("discovered", String(Date.now()));
  }

  /** The folders a design's opening let Ponzu into. */
  private grantFor(key: string): void {
    const guard = guardOf(key);
    if (!guard || this.granted.has(guard)) return;
    this.granted.add(guard);
    this.db.grant(guard);
    void this.saveState();
  }

  /** What versions before the database kept in catalog.json, read in once. */
  private importState(): void {
    const file = this.opts.stateFile;
    if (!file || this.db.meta("imported_json")) return;
    let saved: { granted?: unknown; opened?: unknown } = {};
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    for (const g of Array.isArray(saved.granted) ? saved.granted : [])
      if (typeof g === "string") this.db.grant(g);
    for (const k of Array.isArray(saved.opened) ? saved.opened : [])
      if (typeof k === "string") this.db.opened(realpathOr(k));
    this.db.setMeta("imported_json", String(Date.now()));
  }

  /** catalog.json for older versions: the folders let in, so going back doesn't ask again. */
  private async saveState(): Promise<void> {
    const file = this.opts.stateFile;
    if (!file) return;
    try {
      let saved: Record<string, unknown> = {};
      try {
        saved = JSON.parse(await readFile(file, "utf8"));
      } catch {}
      await mkdir(dirname(file), { recursive: true });
      const state = { ...saved, granted: [...this.granted].sort() };
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    } catch {}
  }

  /** One design's name, pages, artboards and last edit. Re-read when it changes. */
  private async summary(key: string): Promise<CatalogSummary | null> {
    let modified: number;
    try {
      modified = await this.lastEdit(key);
    } catch {
      return null;
    }
    const cached = this.summaries.get(key);
    if (cached && cached.modified === modified) return cached.summary;
    const summary = await readSummary(key, modified);
    this.summaries.set(key, { modified, summary });
    return summary;
  }

  private async git(key: string): Promise<CatalogGit | null> {
    const hit = this.gits.get(key);
    if (hit && Date.now() - hit.at < GIT_TTL) return hit.git;
    const git = await gitOf(key).catch(() => null);
    this.gits.set(key, { at: Date.now(), git });
    return git;
  }

  private async lastEdit(key: string): Promise<number> {
    const hit = this.edits.get(key);
    // Still there? A deleted worktree's design drops off on the next listing.
    if (hit && Date.now() - hit.at < EDIT_TTL && (await exists(join(key, "design.json"))))
      return hit.modified;
    const modified = await lastEdit(key);
    this.edits.set(key, { at: Date.now(), modified });
    return modified;
  }
}

/** The guarded folder a path is in, if any. */
export function guardOf(key: string): string | null {
  const home = homedir();
  for (const g of GUARDED) {
    const dir = join(home, g);
    if (key.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

/** Not designs inside apps, caches or the trash, nor hidden ones. Spotlight already skips most. */
function isListed(key: string): boolean {
  return !/\/(node_modules|\.Trash|\.cache)\//.test(key) && !/\/\.[^/]+\.design$/.test(key);
}

/**
 * The git checkout a design is in: the nearest folder up from it with a
 * `.git`, the branch its HEAD names, and the project every checkout of the
 * repository shares. Read from the files, without running git. A worktree's
 * `.git` is a file pointing at its own HEAD, under the main checkout's.
 */
export async function gitOf(key: string): Promise<CatalogGit | null> {
  for (let dir = key; ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git");
    const s = await stat(dotgit).catch(() => null);
    if (s) {
      let gitdir = dotgit;
      if (s.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotgit, "utf8"));
        if (!m) return null;
        gitdir = resolve(dir, m[1]!.trim());
      }
      // A worktree's own folder names the repository's shared one.
      const common = await readFile(join(gitdir, "commondir"), "utf8").then(
        (c) => resolve(gitdir, c.trim()),
        () => gitdir,
      );
      const project = await projectOf(common);
      const head = (await readFile(join(gitdir, "HEAD"), "utf8")).trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref) return { root: dir, branch: ref[1]!, ...project };
      return /^[0-9a-f]{7,}$/.test(head)
        ? { root: dir, commit: head.slice(0, 7), ...project }
        : { root: dir, ...project };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Every checkout of the repository `root` is a checkout of: the main one and its worktrees. */
async function checkoutsOf(root: string): Promise<string[]> {
  const out = [root];
  const dotgit = join(root, ".git");
  let gitdir = dotgit;
  const s = await stat(dotgit).catch(() => null);
  if (!s) return out;
  if (s.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotgit, "utf8").catch(() => ""));
    if (!m) return out;
    gitdir = resolve(root, m[1]!.trim());
  }
  const common = await readFile(join(gitdir, "commondir"), "utf8").then(
    (c) => resolve(gitdir, c.trim()),
    () => gitdir,
  );
  if (basename(common) === ".git") out.push(dirname(common));
  let trees: string[] = [];
  try {
    trees = await readdir(join(common, "worktrees"));
  } catch {}
  for (const t of trees) {
    // Each names its checkout's .git file; a pruned worktree's is gone.
    const at = await readFile(join(common, "worktrees", t, "gitdir"), "utf8").catch(() => "");
    if (at.trim()) out.push(dirname(at.trim()));
  }
  return [...new Set(out)];
}

/**
 * A repository's identity across its checkouts and Macs: the origin remote
 * (or the first remote), as `host/owner/name`, or the main checkout's folder.
 */
async function projectOf(common: string): Promise<Pick<CatalogGit, "project" | "projectName">> {
  const config = await readFile(join(common, "config"), "utf8").catch(() => "");
  const remotes = [...config.matchAll(/\[remote "([^"]+)"\][^[]*?\burl\s*=\s*(\S+)/g)];
  const url = (remotes.find((r) => r[1] === "origin") ?? remotes[0])?.[2];
  const project = url ? remoteId(url) : null;
  if (project) return { project, projectName: project.split("/").pop()! };
  // No remote: the folder the main checkout's .git is in, or a bare repository's own.
  const folder = basename(common) === ".git" ? dirname(common) : common;
  return { project: folder, projectName: basename(folder).replace(/\.git$/, "") };
}

/** `git@github.com:a/b.git`, `https://github.com/a/b`, `ssh://git@host:22/a/b.git` → `github.com/a/b`. */
export function remoteId(url: string): string | null {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(url);
      if (u.protocol === "file:") return null;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return path ? `${host.toLowerCase()}/${path}` : null;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function realpathOr(key: string): string {
  try {
    return realpathSync(key);
  } catch {
    return key;
  }
}

function lockedSummary(key: string, modified: number, shelf: CatalogShelf): CatalogSummary {
  return {
    key,
    name: basename(key).replace(/\.design$/, ""),
    modified,
    locked: true,
    previewAt: null,
    example: false,
    scratch: false,
    shelf,
    pages: [],
    artboards: [],
  };
}

/** .design folders Spotlight knows of, with their last change. Null when Spotlight can't answer. */
function mdfind(): Promise<Map<string, number> | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: Map<string, number> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(
      "mdfind",
      ["-attr", "kMDItemFSContentChangeDate", "kMDItemFSName == '*.design'"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 5000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) return finish(null);
      const found = new Map<string, number>();
      for (const line of out.split("\n")) {
        const m = /^(.+\.design)\s+kMDItemFSContentChangeDate = (.+)$/.exec(line);
        if (!m) continue;
        // "2026-10-20 05:13:28 +0000"
        const d = /^(\S+) (\S+) ([+-]\d\d)(\d\d)$/.exec(m[2]!.trim());
        const at = d ? Date.parse(`${d[1]}T${d[2]}${d[3]}:${d[4]}`) : Number.NaN;
        found.set(m[1]!, Number.isNaN(at) ? 0 : at);
      }
      finish(found);
    });
  });
}

/** Folders a walk never goes into: they're big and never hold a person's designs. */
const SKIP = new Set([
  ".git",
  "node_modules",
  ".Trash",
  ".cache",
  ".next",
  ".turbo",
  "dist",
  "out",
]);

/**
 * .design folders under `dir`, a few levels down. `enter` vets every folder
 * before it's read, the root included: a walk from the home folder must not
 * wander into Documents and set off its privacy prompt. `hidden` goes into
 * dot-folders too, as a checkout's walk does (.context, .claude/worktrees).
 */
async function walk(
  dir: string,
  depth: number,
  enter: (dir: string) => boolean,
  opts: { hidden?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  if (!enter(dir)) return out;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    if (e.name.startsWith(".") && !opts.hidden) continue;
    const p = join(dir, e.name);
    if (e.name.endsWith(".design")) out.push(p);
    else if (depth > 0) out.push(...(await walk(p, depth - 1, enter, opts)));
  }
  return out;
}

/**
 * When the design last changed: the newest of design.json and what's in its
 * page folders. Notes, assets and the preview don't count, and neither does
 * the folder itself, which writing a preview touches.
 */
async function lastEdit(key: string): Promise<number> {
  let latest = (await stat(join(key, "design.json"))).mtimeMs;
  const visit = async (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "assets" || e.name === "notes") continue;
      const p = join(dir, e.name);
      const s = await stat(p).catch(() => null);
      if (s && s.mtimeMs > latest) latest = s.mtimeMs;
      if (e.isDirectory() && depth > 0) await visit(p, depth - 1);
    }
  };
  await visit(key, 2);
  return latest;
}

async function readSummary(key: string, modified: number): Promise<CatalogSummary | null> {
  let meta: {
    name?: string;
    example?: unknown;
    scratch?: unknown;
    pages?: { id?: string; name?: string; icon?: string }[];
  };
  try {
    meta = JSON.parse(await readFile(join(key, "design.json"), "utf8"));
  } catch {
    return null;
  }
  const pages = (meta.pages ?? [])
    .filter((p): p is { id: string; name: string; icon?: string } =>
      Boolean(p && typeof p.id === "string" && typeof p.name === "string"),
    )
    .map(({ id, name, icon }) => (icon ? { id, name, icon } : { id, name }));
  const artboards: CatalogSummary["artboards"] = [];
  let folders: string[] = [];
  try {
    folders = (await readdir(join(key, "pages"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {}
  for (const folder of folders) {
    // Folders are slugs of page names; one that matches no listed page is a page of its own.
    let page = pages.find((p) => slug(p.name) === folder);
    if (!page) {
      page = { id: `folder:${folder}`, name: folder };
      pages.push(page);
    }
    let files: string[] = [];
    try {
      files = (await readdir(join(key, "pages", folder))).filter((f) => f.endsWith(".html"));
    } catch {}
    for (const f of files.sort()) {
      try {
        const html = await readFile(join(key, "pages", folder, f), "utf8");
        // The same fallback id the store gives a file without one.
        const id = hashedId("ab", `pages/${folder}/${f}`);
        const { artboard } = parseArtboardFile(html, { id, name: f.replace(/\.html$/, "") });
        artboards.push({ id: artboard.id, name: artboard.name, page: page.id });
      } catch {}
    }
  }
  return {
    key,
    name: meta.name || basename(key).replace(/\.design$/, ""),
    modified,
    locked: false,
    previewAt: null,
    example: meta.example === true,
    scratch: meta.scratch === true,
    shelf: "recent",
    pages,
    artboards,
  };
}

function fromDoc(doc: Doc): Pick<CatalogSummary, "name" | "pages" | "artboards"> {
  return {
    name: doc.name,
    pages: doc.pages.map(({ id, name, icon }) => (icon ? { id, name, icon } : { id, name })),
    artboards: doc.pages.flatMap((p) =>
      p.artboards.map((a) => ({ id: a.id, name: a.name, page: p.id })),
    ),
  };
}

function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page"
  );
}

/**
 * What the catalog sends for one design. A readable design always gets a
 * preview URL: the server draws a missing preview on first request. Its
 * version is the later of the preview and the last edit, so an edit the
 * preview hasn't caught up with asks again, and the server redraws it.
 */
export function catalogFile(
  s: CatalogSummary,
  opts: { busy?: string; created?: number },
): CatalogFile {
  const enc = encodeURIComponent(s.key);
  const v = Math.round(Math.max(s.previewAt ?? 0, s.modified));
  const at = Math.round(s.modified);
  return {
    id: `local:${s.key}`,
    key: s.key,
    name: s.name,
    machine: "local",
    base: "",
    modified: s.modified,
    preview: s.locked ? null : `/api/preview?file=${enc}&v=${PREVIEW_VERSION}-${v}`,
    ...(s.locked ? { locked: true } : {}),
    ...(opts.busy ? { busy: opts.busy } : {}),
    ...(opts.created ? { created: opts.created } : {}),
    ...(s.git ? { git: s.git } : {}),
    shelf: s.shelf,
    ...(s.archived ? { archived: s.archived } : {}),
    pages: s.pages,
    artboards: s.artboards.map((a) => ({
      ...a,
      thumb: `/api/thumb?file=${enc}&artboard=${encodeURIComponent(a.id)}&v=${at}`,
    })),
  };
}

/** A Mac with a battery is a laptop. */
export async function machineKind(): Promise<"laptop" | "desktop"> {
  if (process.platform !== "darwin") return "desktop";
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("pmset", ["-g", "batt"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => resolve("desktop"));
    child.on("close", () => resolve(/InternalBattery/.test(out) ? "laptop" : "desktop"));
  });
}

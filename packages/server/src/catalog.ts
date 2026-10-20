import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CatalogArtboard, type CatalogFile, type Doc, parseArtboardFile } from "@ponzu/core";
import { PREVIEW_FILE } from "./preview.ts";

/** How long a scan for .design folders stays fresh. */
const SCAN_TTL = 30_000;
/** How long a design's last-edit time stays fresh: the home screen polls. */
const EDIT_TTL = 3_000;

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
  /** Remembers which guarded folders this Mac has let Ponzu read. */
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
  pages: CatalogFile["pages"];
  artboards: Omit<CatalogArtboard, "thumb">[];
}

/**
 * Every .design on this Mac, newest edit first. Spotlight finds them anywhere;
 * without it (Linux, an unindexed disk) a shallow walk of the usual folders
 * stands in.
 */
export class LocalCatalog {
  private scanned: Promise<Map<string, number>> | null = null;
  private scannedAt = 0;
  private extra = new Set<string>();
  private edits = new Map<string, { at: number; modified: number }>();
  private summaries = new Map<string, { modified: number; summary: CatalogSummary | null }>();
  private granted: Set<string>;

  constructor(private opts: CatalogOptions = {}) {
    let saved: { granted?: string[] } = {};
    try {
      if (opts.stateFile) saved = JSON.parse(readFileSync(opts.stateFile, "utf8"));
    } catch {}
    this.granted = new Set(saved.granted);
  }

  /**
   * A design this server opened or created. It's listed before the next scan
   * finds it, and opening it read it, so its folder is readable.
   */
  add(key: string): void {
    this.extra.add(key);
    this.scannedAt = 0;
    const guard = guardOf(key);
    if (guard && !this.granted.has(guard)) {
      this.granted.add(guard);
      void this.save();
    }
  }

  /** Whether a design is listed here, so its preview, thumbnails and assets may be served. */
  async has(key: string): Promise<boolean> {
    return this.extra.has(key) || (await this.scan()).has(key);
  }

  /** Whether reading this design can't stop on a privacy prompt. */
  readable(key: string): boolean {
    const guard = guardOf(key);
    return !guard || this.granted.has(guard);
  }

  /**
   * Every design here, newest edit first. Open designs pass their live doc, so
   * an edit shows before it reaches the disk. With `present`, someone is
   * looking at the home screen on this Mac: a guarded folder that holds a
   * design is read then, so a privacy prompt for it comes up while they can
   * answer it, and only when there's a design to show.
   */
  async files(open: Map<string, Doc>, present = false): Promise<CatalogSummary[]> {
    const found = await this.scan();
    // One entry per folder, however it was reached (/tmp is /private/tmp, a symlinked
    // project, …). An open design's own key wins, so its card opens the same socket.
    const byReal = new Map<string, string>();
    for (const k of [...found.keys(), ...this.extra, ...open.keys()]) {
      const real = await realpath(k).catch(() => k);
      if (!byReal.has(real) || open.has(k)) byReal.set(real, k);
    }
    const keys = new Set(byReal.values());
    if (present) await this.unlock([...keys]);
    const out: CatalogSummary[] = [];
    await Promise.all(
      [...keys].map(async (key) => {
        const doc = open.get(key);
        if (!doc && !this.readable(key)) {
          out.push(lockedSummary(key, found.get(key) ?? 0));
          return;
        }
        const s = await this.summary(key);
        if (!s) return;
        const previewAt = await stat(join(key, PREVIEW_FILE)).then(
          (st) => st.mtimeMs,
          () => null,
        );
        out.push(doc ? { ...s, ...fromDoc(doc), previewAt } : { ...s, previewAt });
      }),
    );
    return out.sort((a, b) => b.modified - a.modified);
  }

  /** Read one design in each guarded folder not yet known to be readable. */
  private async unlock(keys: string[]): Promise<void> {
    const tried = new Set<string>();
    for (const key of keys) {
      const guard = guardOf(key);
      if (!guard || this.granted.has(guard) || tried.has(guard)) continue;
      tried.add(guard);
      try {
        // Reading a file, not just listing it, is what macOS guards and asks about.
        await readFile(join(key, "design.json"));
        this.granted.add(guard);
        await this.save();
      } catch {}
    }
  }

  private async save(): Promise<void> {
    const file = this.opts.stateFile;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ granted: [...this.granted].sort() }, null, 2)}\n`);
    } catch {}
  }

  /** Every design found, with Spotlight's last-change time where it knows one. */
  private scan(): Promise<Map<string, number>> {
    if (this.scanned && Date.now() - this.scannedAt < SCAN_TTL) return this.scanned;
    this.scannedAt = Date.now();
    const roots = this.opts.roots ?? [];
    const useSpotlight = this.opts.spotlight ?? process.platform === "darwin";
    this.scanned = (async () => {
      const found = new Map<string, number>();
      const spotlight = useSpotlight === true ? await mdfind() : null;
      if (spotlight) for (const [k, t] of spotlight) found.set(k, t);
      // Without Spotlight, walk the usual folders. Never the guarded ones: walking one
      // would ask for access before there's any reason to.
      const dirs =
        spotlight || useSpotlight === "roots"
          ? roots
          : [...roots, ...FALLBACK_DIRS.map((d) => join(homedir(), d))];
      for (const dir of dirs)
        if (this.readable(`${dir}/`)) for (const k of await walk(dir, 4)) found.set(k, 0);
      for (const k of found.keys()) if (!isListed(k)) found.delete(k);
      return found;
    })();
    return this.scanned;
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

  private async lastEdit(key: string): Promise<number> {
    const hit = this.edits.get(key);
    if (hit && Date.now() - hit.at < EDIT_TTL) return hit.modified;
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

/** Not designs inside apps, caches, the trash or hidden folders. Spotlight already skips most. */
function isListed(key: string): boolean {
  return !/\/(node_modules|\.Trash|\.cache)\//.test(key) && !/\/\.[^/]+\.design$/.test(key);
}

function lockedSummary(key: string, modified: number): CatalogSummary {
  return {
    key,
    name: basename(key).replace(/\.design$/, ""),
    modified,
    locked: true,
    previewAt: null,
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

async function walk(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.name.endsWith(".design")) out.push(p);
    else if (depth > 0) out.push(...(await walk(p, depth - 1)));
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
  let meta: { name?: string; pages?: { id?: string; name?: string; icon?: string }[] };
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
        const { artboard } = parseArtboardFile(html, { id: f, name: f.replace(/\.html$/, "") });
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
 * preview URL: the server draws a missing preview on first request.
 */
export function catalogFile(
  s: CatalogSummary,
  opts: { busy?: string; created?: number },
): CatalogFile {
  const enc = encodeURIComponent(s.key);
  const v = Math.round(s.previewAt ?? 0);
  const at = Math.round(s.modified);
  return {
    id: `local:${s.key}`,
    key: s.key,
    name: s.name,
    machine: "local",
    base: "",
    modified: s.modified,
    preview: s.locked ? null : `/api/preview?file=${enc}&v=${v}`,
    ...(s.locked ? { locked: true } : {}),
    ...(opts.busy ? { busy: opts.busy } : {}),
    ...(opts.created ? { created: opts.created } : {}),
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

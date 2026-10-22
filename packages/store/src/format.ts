import {
  type Artboard,
  type DesignMeta,
  type Doc,
  type Dropped,
  emptyDoc,
  hashedId,
  metaOf,
  newId,
  parseArtboardFile,
  serializeArtboardFile,
  slugify,
  type Thread,
  uniqueName,
} from "@ponzu/core";

/**
 * The .design convention, independent of where bytes live:
 *
 *   name.design/
 *     design.json        { ponzu: 1, name, icon?, example?, scratch?, pages: [{ id, name, icon? }] }
 *     tokens.css         :root { --token: value }
 *     comments.json      { threads: [{ id, artboardId (+ nodeId?) | pageId, x, y, status,
 *                          createdAt, updatedAt, messages: [{ id, author, text, createdAt }] }] }
 *     notes/*.md         agent field notes
 *     assets/            images, fonts
 *     pages/<page>/<artboard>.html
 *
 * Page folders and artboard files are named from slugs of their names.
 * A page's folder follows from the page list alone (see `pageFolders`), so
 * renaming or reordering pages moves folders. Artboard ids live inside the
 * files, so renaming a file never loses identity.
 * get_guide('format') spells this out for agents writing the files by hand.
 */
export interface FileBag {
  /** Relative path → text content. Binary assets are not part of the bag. */
  [path: string]: string;
}

export interface Layout {
  /** page id → folder name */
  pages: Map<string, string>;
  /** artboard id → relative path */
  artboards: Map<string, string>;
}

export function emptyLayout(): Layout {
  return { pages: new Map(), artboards: new Map() };
}

/** Something in the files Ponzu couldn't use as written. */
export interface Problem {
  path: string;
  what: string;
}

export interface ReadResult {
  doc: Doc;
  layout: Layout;
  /** Content stripped from artboards, comment threads left out, ids missing. */
  problems: Problem[];
  /** Raw comment threads Ponzu can't use, kept so writing comments.json doesn't lose them. */
  unreadable: unknown[];
  /** artboard id → ids derived from position, for elements whose file gave them none. */
  lazy: Map<string, Set<string>>;
}

export function readBag(bag: FileBag, fallbackName: string): ReadResult {
  const layout = emptyLayout();
  const problems: Problem[] = [];
  const lazy: ReadResult["lazy"] = new Map();
  const meta = parseMeta(bag["design.json"], fallbackName, problems);
  const doc = emptyDoc(meta.name);
  if (meta.icon) doc.icon = meta.icon;
  if (meta.example) doc.example = true;
  if (meta.scratch) doc.scratch = true;
  doc.tokens = bag["tokens.css"] ?? ":root {\n}\n";
  const { threads, unreadable } = parseThreads(bag["comments.json"], problems);
  doc.threads = threads;
  for (const [path, content] of Object.entries(bag)) {
    const m = /^notes\/(.+)\.md$/.exec(path);
    if (m) doc.notes[m[1]!] = content;
  }

  const folders = new Map<string, string[]>();
  for (const path of Object.keys(bag).sort()) {
    const m = /^pages\/([^/]+)\/([^/]+)\.html$/.exec(path);
    if (!m) continue;
    const list = folders.get(m[1]!) ?? [];
    list.push(path);
    folders.set(m[1]!, list);
  }

  // Pages listed in design.json come first, in order. Folders with no entry are appended.
  const claimed = new Set<string>();
  const pageEntries: { id: string; name: string; icon?: string; folder: string }[] = [];
  const named = pageFolders(meta.pages);
  meta.pages.forEach((p, i) => {
    claimed.add(named[i]!);
    pageEntries.push({ ...p, folder: named[i]! });
  });
  for (const folder of [...folders.keys()].sort()) {
    if (claimed.has(folder)) continue;
    claimed.add(folder);
    pageEntries.push({ id: newId("pg"), name: titleCase(folder), folder });
  }

  const seenArtboards = new Set<string>();
  for (const entry of pageEntries) {
    const { folder, ...pageMeta } = entry;
    layout.pages.set(entry.id, folder);
    const artboards: Artboard[] = [];
    for (const path of folders.get(folder) ?? []) {
      const base = path.slice(path.lastIndexOf("/") + 1, -5);
      // Derived from the whole path, so every file gets its own id (and its
      // elements their own positional ids) and keeps it across reloads.
      const fallbackId = hashedId("ab", path);
      const { artboard, dropped, assigned } = parseArtboardFile(bag[path]!, {
        id: fallbackId,
        name: titleCase(base),
      });
      // A copied file still carrying its original's id: tell them apart.
      if (seenArtboards.has(artboard.id))
        artboard.id = seenArtboards.has(fallbackId) ? newId("ab") : fallbackId;
      seenArtboards.add(artboard.id);
      artboard.root.id = artboard.id;
      if (assigned.size) lazy.set(artboard.id, assigned);
      for (const x of dropped) problems.push({ path, what: `removed ${x.what}` });
      layout.artboards.set(artboard.id, path);
      artboards.push(artboard);
    }
    doc.pages.push({ ...pageMeta, artboards });
  }

  if (doc.pages.length === 0) {
    const id = newId("pg");
    doc.pages.push({ id, name: "Page 1", artboards: [] });
    layout.pages.set(id, "page-1");
  }
  return { doc, layout, problems, unreadable, lazy };
}

/**
 * Each page's folder, in list order: the slug of its name, with -2, -3… for
 * pages that share one. Reading and writing both use this, so whatever Ponzu
 * writes reads back as the same pages.
 */
export function pageFolders(pages: readonly { name: string }[]): string[] {
  const used = new Set<string>();
  return pages.map((p) => {
    const folder = uniqueName(slugify(p.name, "page"), (n) => used.has(n));
    used.add(folder);
    return folder;
  });
}

function parseMeta(
  text: string | undefined,
  fallbackName: string,
  problems: Problem[],
): DesignMeta {
  // An empty file is there but unreadable: reported below, unlike a missing one.
  if (text === undefined) return { ponzu: 1, name: fallbackName, pages: [] };
  try {
    const raw = JSON.parse(text) as Partial<DesignMeta>;
    // Without an id a page gets a new one on every read, and pins on its canvas lose it.
    for (const p of Array.isArray(raw.pages) ? raw.pages : [])
      if (p && typeof p.name === "string" && typeof p.id !== "string")
        problems.push({ path: "design.json", what: `page "${p.name}" has no id` });
    return {
      ponzu: 1,
      name: typeof raw.name === "string" && raw.name ? raw.name : fallbackName,
      ...(typeof raw.icon === "string" && raw.icon ? { icon: raw.icon } : {}),
      ...(raw.example === true ? { example: true as const } : {}),
      ...(raw.scratch === true ? { scratch: true as const } : {}),
      pages: Array.isArray(raw.pages)
        ? raw.pages
            .filter((p) => p && typeof p.name === "string")
            .map((p) => ({
              id: typeof p.id === "string" ? p.id : newId("pg"),
              name: p.name,
              ...(p.icon ? { icon: p.icon } : {}),
            }))
        : [],
    };
  } catch {
    problems.push({ path: "design.json", what: "not valid JSON" });
    return { ponzu: 1, name: fallbackName, pages: [] };
  }
}

function parseThreads(
  text: string | undefined,
  problems: Problem[],
): { threads: Thread[]; unreadable: unknown[] } {
  const threads: Thread[] = [];
  const unreadable: unknown[] = [];
  if (text === undefined) return { threads, unreadable };
  let raw: { threads?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    problems.push({ path: "comments.json", what: "not valid JSON" });
    return { threads, unreadable };
  }
  if (!Array.isArray(raw?.threads)) {
    problems.push({ path: "comments.json", what: 'no "threads" list' });
    return { threads, unreadable };
  }
  raw.threads.forEach((t, i) => {
    const missing = threadFaults(t);
    if (!missing.length) return threads.push(t as Thread);
    unreadable.push(t);
    const id = (t as { id?: unknown })?.id;
    const which = typeof id === "string" && id ? id : `#${i + 1}`;
    problems.push({
      path: "comments.json",
      what: `thread ${which} not shown, needs ${missing.join(", ")}`,
    });
  });
  return { threads, unreadable };
}

/** What a thread from disk lacks to be shown, in words. Empty when it's whole. */
function threadFaults(t: unknown): string[] {
  if (!t || typeof t !== "object") return ["to be an object"];
  const o = t as Record<string, unknown>;
  const out: string[] = [];
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!str(o.id)) out.push("id");
  if (!str(o.artboardId) && !str(o.pageId)) out.push("artboardId or pageId");
  if (!num(o.x) || !num(o.y)) out.push("x and y");
  if (o.status !== "open" && o.status !== "resolved") out.push('status "open" or "resolved"');
  if (!num(o.createdAt) || !num(o.updatedAt)) out.push("createdAt and updatedAt");
  if (!Array.isArray(o.messages) || !o.messages.every(messageWhole))
    out.push("messages, each with id, author { kind, name }, text and createdAt");
  return out;
}

function messageWhole(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  const author = o.author as Record<string, unknown> | undefined;
  return (
    typeof o.id === "string" &&
    typeof o.text === "string" &&
    typeof o.createdAt === "number" &&
    (author?.kind === "user" || author?.kind === "agent") &&
    typeof author.name === "string"
  );
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decide where every page and artboard lives. Page folders come from
 * `pageFolders`, as reading finds them, so renaming or reordering pages moves
 * them. Artboard files keep their names until their artboard is renamed.
 */
export function planLayout(doc: Doc, prev: Layout): Layout {
  const next = emptyLayout();
  const folders = pageFolders(doc.pages);
  doc.pages.forEach((page, i) => {
    const folder = folders[i]!;
    next.pages.set(page.id, folder);
    const usedFiles = new Set<string>();
    for (const ab of page.artboards) {
      const want = slugify(ab.name, "artboard");
      const old = prev.artboards.get(ab.id);
      const oldBase = old?.startsWith(`pages/${folder}/`)
        ? old.slice(old.lastIndexOf("/") + 1, -5)
        : null;
      const base =
        oldBase && (oldBase === want || oldBase.startsWith(`${want}-`)) && !usedFiles.has(oldBase)
          ? oldBase
          : uniqueName(want, (n) => usedFiles.has(n));
      usedFiles.add(base);
      next.artboards.set(ab.id, `pages/${folder}/${base}.html`);
    }
  });
  return next;
}

export function serializeMeta(doc: Doc): string {
  return `${JSON.stringify(metaOf(doc), null, 2)}\n`;
}

/** `unreadable` threads go back as they were, after the rest, so fixing them by hand still works. */
export function serializeThreads(doc: Doc, unreadable: unknown[] = []): string {
  return `${JSON.stringify({ threads: [...doc.threads, ...unreadable] }, null, 2)}\n`;
}

export function serializeArtboard(ab: Artboard): string {
  return serializeArtboardFile(ab);
}

/** The complete set of text files for a doc. */
export function writeBag(doc: Doc, layout: Layout): FileBag {
  const bag: FileBag = {
    "design.json": serializeMeta(doc),
    "tokens.css": doc.tokens,
  };
  if (doc.threads.length) bag["comments.json"] = serializeThreads(doc);
  for (const [name, content] of Object.entries(doc.notes)) bag[`notes/${name}.md`] = content;
  for (const page of doc.pages) {
    for (const ab of page.artboards) bag[layout.artboards.get(ab.id)!] = serializeArtboard(ab);
  }
  return bag;
}

export type { Dropped };

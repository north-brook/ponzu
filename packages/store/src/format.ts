import {
  type Artboard,
  type DesignMeta,
  type Doc,
  type Dropped,
  emptyDoc,
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
 *     design.json        { ponzu: 1, name, example?, pages: [{ id, name, icon? }] }
 *     tokens.css         :root { --token: value }
 *     comments.json      { threads: [...] }
 *     notes/*.md         agent field notes
 *     assets/            images, fonts
 *     pages/<page>/<artboard>.html
 *
 * Page folders and artboard files are named from slugs of their names.
 * Ids live inside the files, so renaming a folder never loses identity.
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

export interface ReadResult {
  doc: Doc;
  layout: Layout;
  dropped: { path: string; what: string }[];
}

export function readBag(bag: FileBag, fallbackName: string): ReadResult {
  const layout = emptyLayout();
  const dropped: ReadResult["dropped"] = [];
  const meta = parseMeta(bag["design.json"], fallbackName);
  const doc = emptyDoc(meta.name);
  if (meta.example) doc.example = true;
  doc.tokens = bag["tokens.css"] ?? ":root {\n}\n";
  doc.threads = parseThreads(bag["comments.json"]);
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
  for (const p of meta.pages) {
    const folder = folderFor(p, folders, claimed);
    claimed.add(folder);
    pageEntries.push({ ...p, folder });
  }
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
      const fallbackId = `ab_${slugify(`${folder}-${base}`).replace(/-/g, "").slice(0, 10)}`;
      const { artboard, dropped: d } = parseArtboardFile(bag[path]!, {
        id: fallbackId,
        name: titleCase(base),
      });
      if (seenArtboards.has(artboard.id)) artboard.id = newId("ab");
      seenArtboards.add(artboard.id);
      artboard.root.id = artboard.id;
      for (const x of d) dropped.push({ path, what: x.what });
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
  return { doc, layout, dropped };
}

function folderFor(
  p: { id: string; name: string },
  folders: Map<string, string[]>,
  claimed: Set<string>,
): string {
  const slug = slugify(p.name, "page");
  if (folders.has(slug) && !claimed.has(slug)) return slug;
  // A folder holding artboards whose files carry the page id hint (renamed folder on disk).
  return uniqueName(slug, (n) => claimed.has(n));
}

function parseMeta(text: string | undefined, fallbackName: string): DesignMeta {
  if (!text) return { ponzu: 1, name: fallbackName, pages: [] };
  try {
    const raw = JSON.parse(text) as Partial<DesignMeta>;
    return {
      ponzu: 1,
      name: typeof raw.name === "string" && raw.name ? raw.name : fallbackName,
      ...(raw.example === true ? { example: true as const } : {}),
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
    return { ponzu: 1, name: fallbackName, pages: [] };
  }
}

function parseThreads(text: string | undefined): Thread[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as { threads?: Thread[] };
    return Array.isArray(raw.threads) ? raw.threads : [];
  } catch {
    return [];
  }
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decide where every page and artboard lives, keeping existing paths when
 * names haven't changed so renames are the only thing that moves files.
 */
export function planLayout(doc: Doc, prev: Layout): Layout {
  const next = emptyLayout();
  const usedFolders = new Set<string>();
  for (const page of doc.pages) {
    const want = slugify(page.name, "page");
    const old = prev.pages.get(page.id);
    const folder =
      old && (old === want || old.startsWith(`${want}-`)) && !usedFolders.has(old)
        ? old
        : uniqueName(want, (n) => usedFolders.has(n));
    usedFolders.add(folder);
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
  }
  return next;
}

export function serializeMeta(doc: Doc): string {
  return `${JSON.stringify(metaOf(doc), null, 2)}\n`;
}

export function serializeThreads(doc: Doc): string {
  return `${JSON.stringify({ threads: doc.threads }, null, 2)}\n`;
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

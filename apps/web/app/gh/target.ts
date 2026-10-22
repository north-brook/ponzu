/*
 * What a /gh URL asks for, and where things live in a repo's tree. Pure, so
 * the tests run without Next or the network. The URL itself is read by
 * @ponzu/core's github.ts, which `ponzu open` shares.
 */

export {
  folderName,
  parseTarget,
  type Repo,
  type Target,
  viewerPath,
} from "@ponzu/core/github";

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

/**
 * The text files `readBag` reads (packages/store/src/format.ts), from a
 * design's own tree. Everything else (assets/, exports, stray files) is left
 * on GitHub: the canvas loads assets straight from there.
 */
export function bagFiles(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter(
    (e) =>
      e.type === "blob" &&
      (e.path === "design.json" ||
        e.path === "tokens.css" ||
        e.path === "comments.json" ||
        /^notes\/.+\.md$/.test(e.path) ||
        /^pages\/[^/]+\/[^/]+\.html$/.test(e.path)),
  );
}

export interface FoundDesign {
  path: string;
  /** Artboard files, counted from the tree without reading them. */
  artboards: number;
  pages: number;
  assets: number;
  /** Whether it has a design.json to read its name from. */
  meta: boolean;
}

/**
 * Every .design folder in a repo's tree, under `prefix`. A .design inside
 * another one is part of it, not a design of its own.
 */
export function findDesigns(tree: TreeEntry[], prefix = ""): FoundDesign[] {
  const under = prefix ? `${prefix}/` : "";
  const roots = tree
    .filter((e) => e.type === "tree" && /(^|\/)[^/]+\.design$/.test(e.path))
    .map((e) => e.path)
    .filter((p) => p.startsWith(under))
    .sort();
  const designs: FoundDesign[] = [];
  for (const path of roots) {
    if (designs.some((d) => path.startsWith(`${d.path}/`))) continue;
    designs.push({ path, artboards: 0, pages: 0, assets: 0, meta: false });
  }
  const pages = new Map<string, Set<string>>();
  for (const e of tree) {
    if (e.type !== "blob") continue;
    const d = designs.find((x) => e.path.startsWith(`${x.path}/`));
    if (!d) continue;
    const rel = e.path.slice(d.path.length + 1);
    if (rel === "design.json") d.meta = true;
    else if (rel.startsWith("assets/")) d.assets++;
    const page = /^pages\/([^/]+)\/[^/]+\.html$/.exec(rel)?.[1];
    if (page) {
      d.artboards++;
      const seen = pages.get(d.path) ?? new Set();
      seen.add(page);
      pages.set(d.path, seen);
    }
  }
  for (const d of designs) d.pages = pages.get(d.path)?.size ?? 0;
  return designs;
}

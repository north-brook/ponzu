/*
 * What a /gh URL asks for, and where things live in a repo's tree. Pure, so
 * the tests run without Next or the network.
 *
 *   /gh/<owner>/<repo>                         every .design in the repo
 *   /gh/<owner>/<repo>/<folder>                every .design under that folder
 *   /gh/<owner>/<repo>/<path/to/name.design>   one design, on the canvas
 *   /gh/<owner>/<repo>@<ref>/…                 the same at a branch, tag or commit
 *
 * A ref with a slash in it (`feature/x`) goes in as `feature%2Fx`.
 */

export interface Repo {
  owner: string;
  repo: string;
  /** A branch, tag or commit as written in the URL. Absent means the default branch. */
  ref?: string;
}

export type Target =
  | (Repo & {
      kind: "design";
      path: string /** Segments after the .design, dropped. */;
      extra: boolean;
    })
  | (Repo & { kind: "repo" /** A folder to list under; "" for the whole repo. */; prefix: string });

/** GitHub's own rules, loosely: letters, digits, `-`, `_` and `.`. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** Git refuses `..`, spaces, `~^:?*[\` and control characters in refs. */
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/;

/**
 * Next hands a page its catch-all segments still percent-encoded (`ponzu%40main`)
 * but generateMetadata the same ones decoded, so both go through here. A name
 * that happens to contain a literal `%xx` is read as the character it spells.
 */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseTarget(slug: string[]): Target | null {
  const [owner, head, ...rest] = slug.map(decode);
  if (!owner || !head || !NAME.test(owner)) return null;
  const at = head.indexOf("@");
  const repo = at < 0 ? head : head.slice(0, at);
  const ref = at < 0 ? undefined : head.slice(at + 1);
  if (!NAME.test(repo) || repo === "." || repo === "..") return null;
  if (ref !== undefined && !REF.test(ref)) return null;
  if (rest.some((s) => !s || s === "." || s === ".." || s.includes("/"))) return null;
  const base: Repo = ref ? { owner, repo, ref } : { owner, repo };
  const end = rest.findIndex((s) => s.endsWith(".design") && s.length > ".design".length);
  if (end < 0) return { ...base, kind: "repo", prefix: rest.join("/") };
  return {
    ...base,
    kind: "design",
    path: rest.slice(0, end + 1).join("/"),
    extra: end < rest.length - 1,
  };
}

/** The site path for a repo, a folder in it or a design. */
export function viewerPath(repo: Repo, path = ""): string {
  const head = repo.ref ? `${repo.repo}@${encodeURIComponent(repo.ref)}` : repo.repo;
  const tail = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/gh/${repo.owner}/${head}${tail}`;
}

/** A design's name from its folder: `design/Kettle.design` is "Kettle". */
export function folderName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.design$/, "");
}

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

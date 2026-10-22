/*
 * A design on GitHub, by path. ponzu.design/gh shows one, and `ponzu open` clones its repo
 * and opens it, so both read the same paths:
 *
 *   <owner>/<repo>                         every .design in the repo
 *   <owner>/<repo>/<folder>                every .design under that folder
 *   <owner>/<repo>/<path/to/name.design>   one design
 *   <owner>/<repo>@<ref>/…                 the same at a branch, tag or commit
 *
 * A ref with a slash in it (`feature/x`) goes in as `feature%2Fx`. Pure, so it runs anywhere.
 */

export interface Repo {
  owner: string;
  repo: string;
  /** A branch, tag or commit as written in the path. Absent means the default branch. */
  ref?: string;
}

export type Target =
  | (Repo & {
      kind: "design";
      path: string;
      /** Segments after the .design, dropped. */
      extra: boolean;
    })
  | (Repo & {
      kind: "repo";
      /** A folder to list under; "" for the whole repo. */
      prefix: string;
    });

/** GitHub's own rules, loosely: letters, digits, `-`, `_` and `.`, but never just dots. */
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
/** Git refuses `..`, spaces, `~^:?*[\` and control characters in refs, and a leading `-`. */
const REF = /^(?!.*\.\.)(?![/-])(?!.*\/$)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/;

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

/** A target from its path segments, each maybe still percent-encoded. Null when it can't be on GitHub. */
export function parseTarget(slug: string[]): Target | null {
  const [owner, head, ...rest] = slug.map(decode);
  if (!owner || !head || !NAME.test(owner)) return null;
  const at = head.indexOf("@");
  const repo = at < 0 ? head : head.slice(0, at);
  const ref = at < 0 ? undefined : head.slice(at + 1);
  if (!NAME.test(repo)) return null;
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

/**
 * A segment encoded down to letters, digits and `-_.~%`: `encodeURIComponent` leaves `!'()*`,
 * which a shell reads, so the path pastes into `ponzu open` without quoting.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `owner/repo[@ref]/path`, each segment encoded: what follows /gh/ and `ponzu open`. */
export function targetPath(repo: Repo, path = ""): string {
  const head = repo.ref ? `${repo.repo}@${encodeSegment(repo.ref)}` : repo.repo;
  const tail = path ? `/${path.split("/").map(encodeSegment).join("/")}` : "";
  return `${repo.owner}/${head}${tail}`;
}

/** The site path for a repo, a folder in it or a design. */
export function viewerPath(repo: Repo, path = ""): string {
  return `/gh/${targetPath(repo, path)}`;
}

/** A design's name from its folder: `design/Kettle.design` is "Kettle". */
export function folderName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.design$/, "");
}

/**
 * What `ponzu open` was given: `owner/repo[@ref]/path.design`, a ponzu.design/gh link, or a
 * github.com link to the repo or a folder in it (`/tree/<ref>/…`, with a ref of one segment).
 */
export function parseOpenTarget(input: string): Target | null {
  const raw = input.trim();
  let segments: string[];
  if (/^https?:\/\//i.test(raw) || /^(www\.)?(ponzu\.design|github\.com)\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    // Split before decoding, so an encoded slash in a ref stays inside its segment.
    const parts = url.pathname.split("/").filter(Boolean);
    if (host === "ponzu.design") {
      if (parts[0] !== "gh") return null;
      segments = parts.slice(1);
    } else if (host === "github.com") {
      const [owner, repo, kind, ref, ...rest] = parts;
      if (!owner || !repo) return null;
      const name = repo.replace(/\.git$/, "");
      if (!kind) segments = [owner, name];
      else if ((kind === "tree" || kind === "blob") && ref)
        segments = [owner, `${name}@${ref}`, ...rest];
      else return null;
    } else return null;
  } else {
    segments = raw.split("/").filter(Boolean);
  }
  return parseTarget(segments);
}

import { type Doc, slugify } from "@ponzu/core";
import { readBag } from "@ponzu/store";
import { cache } from "react";
import { bagFiles, DIGEST, findDesigns, firstPageBoards, folderName, type TreeEntry } from "./target.ts";

/*
 * Reads a public repo's .design folders off GitHub, on the server.
 *
 * Three requests to the API per design, two of them cached for good: the repo
 * (is it public, which branch is the default) and its newest commit that
 * touched the design, each kept five minutes; then the design's tree at that
 * commit, which can't change. The text files come from raw.githubusercontent.com
 * at the same commit, also cached for good. Assets never pass through here:
 * the canvas loads them from GitHub at that commit too.
 *
 * GITHUB_TOKEN, when set, only raises the API's rate limit. It never reaches raw
 * requests or the browser, and a repo it can see that isn't public is still refused.
 */

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
/** How long a branch's newest commit is trusted, in seconds. */
const FRESH = 300;
const TIMEOUT = 10_000;

/** Past these, a design is too big to show here; it opens fine in Ponzu itself. */
export const LIMITS = { files: 600, bytes: 12 * 1024 * 1024 };
/** Where Ponzu keeps a design's canvas preview (packages/server/src/preview.ts). */
const PREVIEW = ".ponzu/preview.png";
/** Designs whose design.json the listing reads for a name. */
const NAMED = 48;

export type ViewerErrorKind =
  /** No such repo, or it isn't public. GitHub doesn't say which. */
  | "repo"
  /** No such branch, tag or commit. */
  | "ref"
  /** No .design at that path. */
  | "design"
  /** A .design folder with nothing Ponzu reads in it. */
  | "empty"
  | "too-big"
  /** GitHub's rate limit, ours for everyone on ponzu.design. Passes on its own. */
  | "rate-limited"
  /** GitHub didn't answer, or answered with something unexpected. */
  | "unavailable";

export class ViewerError extends Error {
  /** Set on transient failures, so the error page can tell a rate limit from an outage. */
  readonly digest?: string;

  constructor(
    readonly kind: ViewerErrorKind,
    message: string = kind,
  ) {
    super(message);
    if (kind === "rate-limited" || kind === "unavailable") this.digest = `${DIGEST}${kind}`;
  }

  /** Worth trying again soon. These throw to the error boundary rather than render, so they're never cached. */
  get transient() {
    return this.kind === "rate-limited" || this.kind === "unavailable";
  }
}

export interface RepoInfo {
  owner: string;
  repo: string;
  /** owner/repo as GitHub spells it, which may differ in case from the URL. */
  fullName: string;
  description: string | null;
  stars: number;
  defaultBranch: string;
  /** https://github.com/owner/repo */
  url: string;
  ownerAvatar: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  /** The first line of its message. */
  title: string;
  author: string;
  /** ISO 8601, when it was committed. */
  date: string;
  url: string;
}

export interface DesignView {
  repo: RepoInfo;
  /** The branch, tag or commit asked for, or the default branch. */
  ref: string;
  /** Whether the URL named the ref (`repo@ref`), so links keep it. */
  refInUrl: boolean;
  /** The newest commit at `ref` that touched this design. Everything below is as of it. */
  commit: CommitInfo;
  /** The design folder's path in the repo. */
  path: string;
  name: string;
  doc: Doc;
  stats: {
    pages: number;
    artboards: number;
    /** Open comment threads; resolved ones stay off the canvas. */
    threads: number;
    notes: number;
    assets: number;
    /** Files Ponzu read. */
    files: number;
    bytes: number;
    /** Things the sanitizer stripped or couldn't read, like scripts. */
    problems: number;
  };
  /** Where the canvas loads assets/ from: raw GitHub at `commit`. */
  assetBase: string;
  /**
   * The canvas preview Ponzu draws (.ponzu/preview.png) on raw GitHub, when it was committed.
   * Rare: Ponzu's .ponzu/ folder ignores itself in git.
   */
  preview: string | null;
  /** The design's folder on GitHub at `commit`. */
  githubUrl: string;
}

export interface ListedDesign {
  path: string;
  /** From design.json, or the folder's name. */
  name: string;
  pages: number;
  artboards: number;
  assets: number;
  /** What its card draws, read in the browser from raw GitHub at the listing's commit. */
  thumb: {
    /** The design folder on raw GitHub: its assets/ load from here too. */
    base: string;
    /** The first page's artboard files, relative to `base`. The card draws the top-left one. */
    boards: string[];
    tokens: boolean;
  } | null;
}

export interface RepoView {
  repo: RepoInfo;
  ref: string;
  refInUrl: boolean;
  /** The newest commit at `ref`. */
  commit: CommitInfo;
  /** The folder listed, "" for the whole repo. */
  prefix: string;
  designs: ListedDesign[];
  /** GitHub cut the tree short (over 100,000 files), so some designs may be missing. */
  truncated: boolean;
}

/** One design at a ref. Shared by the page and its metadata within a request. */
export const loadDesign = cache(
  async (owner: string, name: string, ref: string, path: string): Promise<DesignView> => {
    const repo = await repoInfo(owner, name);
    const at = ref || repo.defaultBranch;
    const commit = await newestCommit(repo, at, Boolean(ref), path);
    if (!commit) throw new ViewerError("design", `No ${path} at ${at}`);
    const tree = await getTree(repo, `${commit.sha}:${path}`).catch((e: unknown) => {
      // The path was a file, or went away between the two requests. A rate limit or an outage
      // is GitHub's, not the path's: it goes on to the error page, uncached.
      throw e instanceof ViewerError && e.transient ? e : new ViewerError("design");
    });
    if (tree.truncated) throw new ViewerError("too-big", "Too many files");
    const files = bagFiles(tree.tree);
    const bytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
    if (files.length > LIMITS.files || bytes > LIMITS.bytes)
      throw new ViewerError("too-big", `${files.length} files, ${bytes} bytes`);
    if (!files.some((f) => f.path === "design.json" || f.path.startsWith("pages/")))
      throw new ViewerError("empty");

    const base = `${RAW}/${repo.owner}/${repo.repo}/${commit.sha}/${encodePath(path)}`;
    const texts = await inBatches(files, 12, (f) => text(`${base}/${encodePath(f.path)}`));
    const bag = Object.fromEntries(files.map((f, i) => [f.path, texts[i]!]));
    const { doc, problems } = readBag(bag, folderName(path));
    return {
      repo,
      ref: at,
      refInUrl: Boolean(ref),
      commit,
      path,
      name: doc.name,
      doc,
      stats: {
        pages: doc.pages.length,
        artboards: doc.pages.reduce((n, p) => n + p.artboards.length, 0),
        threads: doc.threads.filter((t) => t.status === "open").length,
        notes: Object.keys(doc.notes).length,
        assets: tree.tree.filter((e) => e.type === "blob" && e.path.startsWith("assets/")).length,
        files: files.length,
        bytes,
        problems: problems.length,
      },
      assetBase: base,
      preview: tree.tree.some((e) => e.type === "blob" && e.path === PREVIEW)
        ? `${base}/${PREVIEW}`
        : null,
      githubUrl: `${repo.url}/tree/${commit.sha}/${encodePath(path)}`,
    };
  },
);

/** Every design in a repo, or in one folder of it. */
export const loadRepo = cache(
  async (owner: string, name: string, ref: string, prefix: string): Promise<RepoView> => {
    const repo = await repoInfo(owner, name);
    const at = ref || repo.defaultBranch;
    const commit = await newestCommit(repo, at, Boolean(ref));
    if (!commit) throw new ViewerError("design", "The repo is empty");
    const tree = await getTree(repo, commit.sha);
    const found = findDesigns(tree.tree, prefix);
    const raw = `${RAW}/${repo.owner}/${repo.repo}/${commit.sha}`;
    const metas = await inBatches(found.slice(0, NAMED), 12, (d) =>
      d.meta
        ? text(`${raw}/${encodePath(d.path)}/design.json`)
            .then((json) => readMeta(JSON.parse(json)))
            .catch(() => null)
        : null,
    );
    return {
      repo,
      ref: at,
      refInUrl: Boolean(ref),
      commit,
      prefix,
      designs: found.map((d, i) => {
        const boards = firstPageBoards(d.boards, metas[i]?.pages);
        return {
          path: d.path,
          name: metas[i]?.name ?? folderName(d.path),
          pages: d.pages,
          artboards: d.artboards,
          assets: d.assets,
          thumb: boards.length
            ? { base: `${raw}/${encodePath(d.path)}`, boards, tokens: d.tokens }
            : null,
        };
      }),
      truncated: tree.truncated,
    };
  },
);

/** A design.json's name, and its pages' folders (slugs of their names), in order. */
function readMeta(raw: unknown): { name: string | null; pages: string[] } {
  const o = (raw ?? {}) as { name?: unknown; pages?: unknown };
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : null;
  const pages = Array.isArray(o.pages)
    ? o.pages
        .map((p) => (p as { name?: unknown } | null)?.name)
        .filter((n): n is string => typeof n === "string")
        .map((n) => slugify(n, "page"))
    : [];
  return { name, pages };
}

async function repoInfo(owner: string, name: string): Promise<RepoInfo> {
  const r = await api<{
    private: boolean;
    name: string;
    full_name: string;
    description: string | null;
    stargazers_count: number;
    default_branch: string;
    html_url: string;
    owner: { login: string; avatar_url: string };
  }>(`/repos/${owner}/${name}`, { next: { revalidate: FRESH } }, "repo");
  // Only possible with a token that can see it. Its files aren't ours to show.
  if (r.private) throw new ViewerError("repo");
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    defaultBranch: r.default_branch,
    url: r.html_url,
    ownerAvatar: r.owner.avatar_url,
  };
}

/** The newest commit at a ref, or the newest there that touched `path`. Null when none did. */
async function newestCommit(
  repo: RepoInfo,
  ref: string,
  named: boolean,
  path?: string,
): Promise<CommitInfo | null> {
  const query = new URLSearchParams({ sha: ref, per_page: "1" });
  if (path) query.set("path", path);
  const list = await api<
    {
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string; date: string } | null };
      author: { login: string } | null;
    }[]
  >(
    `/repos/${repo.owner}/${repo.repo}/commits?${query}`,
    { next: { revalidate: FRESH } },
    // A ref the URL named and GitHub doesn't know. The default branch always exists.
    named ? "ref" : "repo",
  ).catch((e: unknown) => {
    // 409: a repo with no commits at all.
    if (e instanceof ViewerError && e.message === "409") return [];
    throw e;
  });
  const c = list[0];
  if (!c) return null;
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    title: c.commit.message.split("\n")[0] ?? "",
    author: c.author?.login ?? c.commit.author?.name ?? "",
    date: c.commit.author?.date ?? "",
    url: c.html_url,
  };
}

/** A tree is named by a commit (and path), so it's cached for good. */
function getTree(repo: RepoInfo, treeish: string) {
  return api<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${encodePath(treeish)}?recursive=1`,
    { cache: "force-cache" },
    "design",
  );
}

async function api<T>(path: string, init: RequestInit, missing: ViewerErrorKind): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ponzu.design",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request(`${API}${path}`, { ...init, headers });
  if (res.ok) return (await res.json()) as T;
  throw failure(res, missing);
}

/** A file at a commit. Never sent the token: these are public files only. */
async function text(url: string): Promise<string> {
  const res = await request(url, { cache: "force-cache" });
  if (res.ok) return res.text();
  throw failure(res, "unavailable");
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new ViewerError("unavailable", `No answer from ${new URL(url).host}`);
  }
}

function failure(res: Response, missing: ViewerErrorKind): ViewerError {
  const limited =
    res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  if (limited) return new ViewerError("rate-limited");
  // 422: a ref GitHub can't parse; 451: blocked for legal reasons. Both as good as missing.
  if (res.status === 404 || res.status === 422 || res.status === 451)
    return new ViewerError(missing, String(res.status));
  return new ViewerError("unavailable", String(res.status));
}

/** Each path segment encoded, the slashes kept. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `fn` over every item, `size` at a time, in order. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R> | R) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

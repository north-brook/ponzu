import type { Github } from "../deps/github.ts";
import { UpstreamError } from "../http/errors.ts";
import {
  BUDGET,
  cleanReadme,
  excerptTheme,
  hasDarkTheme,
  interfaceOf,
  layoutOf,
  pickManifests,
  pickTheme,
  type RepoSnapshot,
  summarizeManifest,
} from "./snapshot.ts";

type Reader = Pick<Github, "getRepositoryAbout" | "getTree" | "getFileText" | "getReadme">;

/**
 * A light read of one repository at its default branch, never a clone: its page, its tree,
 * then its README, manifests and one theme file at once (`snapshot.ts` has the budget). `token`
 * is an installation token narrowed to the repo with `contents: read`, or null for a public
 * repo read without one. A file that is missing or fails to read is left out; the page and
 * the tree failing fails the read.
 */
export async function readRepository(
  github: Reader,
  token: string | null,
  fullName: string,
): Promise<RepoSnapshot> {
  const about = await github.getRepositoryAbout(token, fullName);
  const ref = about.defaultBranch;
  let tree: Awaited<ReturnType<Reader["getTree"]>>;
  try {
    tree = await github.getTree(token, { fullName, ref, maxBytes: BUDGET.treeBytes });
  } catch (error) {
    // 409: a repository with no commits has no tree.
    if (!(error instanceof UpstreamError && (error.status === 409 || error.status === 404))) {
      throw error;
    }
    tree = { entries: [], complete: true };
  }
  const file = (path: string) =>
    github
      .getFileText(token, { fullName, path, ref, maxBytes: BUDGET.fileBytes })
      .catch(() => null);
  const themePath = pickTheme(tree);
  const manifestPaths = pickManifests(tree);
  const [readme, theme, ...manifests] = await Promise.all([
    tree.entries.length === 0
      ? null
      : github.getReadme(token, { fullName, ref, maxBytes: BUDGET.fileBytes }).catch(() => null),
    themePath ? file(themePath) : null,
    ...manifestPaths.map(file),
  ]);
  const { screens, components } = interfaceOf(tree);
  const themeExcerpt = themePath && theme ? excerptTheme(themePath, theme) : null;
  return {
    fullName,
    description: about.description?.slice(0, BUDGET.description) ?? null,
    topics: about.topics.slice(0, BUDGET.topics),
    language: about.language,
    readme: readme ? cleanReadme(readme) : null,
    layout: layoutOf(tree),
    manifests: manifestPaths.flatMap((path, i) => {
      const text = manifests[i];
      const summary = text ? summarizeManifest(path, text) : null;
      return summary ? [{ path, summary }] : [];
    }),
    screens,
    components,
    theme: themePath && themeExcerpt ? { path: themePath, excerpt: themeExcerpt } : null,
    darkTheme: hasDarkTheme(tree, theme),
    files: tree.entries.filter((entry) => entry.type === "blob").length,
  };
}

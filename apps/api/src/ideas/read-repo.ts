import type { Github } from "../deps/github.ts";
import { UpstreamError } from "../http/errors.ts";
import {
  BUDGET,
  cleanReadme,
  excerptSample,
  excerptTheme,
  hasDarkTheme,
  interfaceOf,
  isUnbuilt,
  layoutOf,
  pickManifests,
  pickSamples,
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
    tree = await github.getTree(token, { fullName, ref });
  } catch (error) {
    // 409: a repository with no commits has no tree.
    if (!(error instanceof UpstreamError && (error.status === 409 || error.status === 404))) {
      throw error;
    }
    tree = { entries: [], complete: true };
  }
  const sizes = new Map(tree.entries.map((entry) => [entry.path, entry.size]));
  // A manifest or theme file larger than its budget is not worth fetching: cut, it would not
  // parse, and it is a generated file more often than a written one.
  const file = (path: string) =>
    (sizes.get(path) ?? 0) > BUDGET.fileBytes
      ? Promise.resolve(null)
      : github
          .getFileText(token, { fullName, path, ref, maxBytes: BUDGET.fileBytes })
          .catch(() => null);
  const themePath = pickTheme(tree);
  const manifestPaths = pickManifests(tree);
  const { screens, components } = interfaceOf(tree);
  const files = tree.entries.filter((entry) => entry.type === "blob").length;
  // Nothing built yet: the few files there are say what it will be, read with the requests
  // the manifests it lacks leave over, so the budget stays the same.
  const samplePaths = isUnbuilt({ screens, components, theme: themePath, files })
    ? pickSamples(
        tree,
        manifestPaths,
        Math.min(BUDGET.samples, BUDGET.manifests - manifestPaths.length),
      )
    : [];
  const [readme, theme, ...texts] = await Promise.all([
    tree.entries.length === 0
      ? null
      : github.getReadme(token, { fullName, ref, maxBytes: BUDGET.fileBytes }).catch(() => null),
    themePath ? file(themePath) : null,
    ...manifestPaths.map(file),
    ...samplePaths.map(file),
  ]);
  const manifests = texts.slice(0, manifestPaths.length);
  const samples = texts.slice(manifestPaths.length);
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
    samples: samplePaths.flatMap((path, i) => {
      const text = samples[i];
      const excerpt = text ? excerptSample(text) : null;
      return excerpt ? [{ path, excerpt }] : [];
    }),
    files,
  };
}

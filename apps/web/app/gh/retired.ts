/*
 * Where a retired /gh link sends its "Open on GitHub" button. Ponzu 1's public viewer read
 * /gh/<owner>/<repo>[@ref]/<path/to/name.design>; the landing keeps only the repo. The slug is
 * whatever someone typed or pasted, so nothing from it reaches the page but an owner and a repo
 * that match GitHub's own alphabets exactly. Anything else links to github.com itself.
 */

/** A GitHub user or organization name. */
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
/** A GitHub repository name. "." and ".." match the alphabet but name no repository. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const GITHUB = "https://github.com";

export interface RetiredRepo {
  /** Where "Open on GitHub" goes: always on https://github.com. */
  href: string;
  /** `<owner>/<repo>`, for the page's sentence, or null when the slug named none. */
  name: string | null;
}

/** A segment as typed: Next hands catch-all segments over still percent-encoded (`%40`). */
function decoded(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function retiredRepo(slug: readonly string[] | undefined): RetiredRepo {
  const owner = decoded(slug?.[0]);
  // The repo segment carried the ref after an @: kettle@main.
  const repo = decoded(slug?.[1])?.split("@")[0];
  if (
    owner === undefined ||
    repo === undefined ||
    !OWNER.test(owner) ||
    !REPO.test(repo) ||
    repo === "." ||
    repo === ".."
  )
    return { href: GITHUB, name: null };
  return { href: `${GITHUB}/${owner}/${repo}`, name: `${owner}/${repo}` };
}

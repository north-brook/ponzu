import type { Repo } from "../model.ts";

/** What a new design is made in: a repo, or Scratch. */
export type ProjectChoice = { kind: "repo"; repo: Repo } | { kind: "scratch" };

/**
 * Another workspace's repos the person can push to, as the picker lists them; `repos` is null
 * while they load. A workspace whose repos couldn't be had has no shelf.
 */
export interface RepoShelf {
  workspaceId: string;
  repos: Repo[] | null;
}

/**
 * Whether the picker offers a search, decided as it opens: once there are enough repos to need
 * one, or while other workspaces' repos are still to come (they join at the list's foot and
 * would make it scroll, and a field arriving over the rows then would move them).
 */
export function searchAtOpening(count: number, elsewhere: readonly RepoShelf[]): boolean {
  return showsSearch(count) || elsewhere.some((shelf) => shelf.repos === null);
}

/** One of the picker's repo rows: the repo, and the workspace it is in (none: the window's). */
export interface RepoRow {
  repo: Repo;
  workspaceId: string | null;
}

/** A repo as the picker and its trigger title it: `north-brook/fernwood`. */
export function fullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** What the selector says: a repo's full name, or Scratch. */
export function projectLabel(choice: ProjectChoice): string {
  return choice.kind === "scratch" ? "Scratch" : fullName(choice.repo);
}

/** A prompt can be sent once it says something, and not twice while the first is going. */
export function canSend(prompt: string, sending: boolean): boolean {
  return !sending && prompt.trim().length > 0;
}

/**
 * The picker's search shows from this many repos: fewer read at a glance (with Scratch, at most
 * five one-line rows), and the arrows reach them as fast as typing would. Five rows is also all
 * the picker's list shows before it scrolls (repo-picker.tsx), so a list that scrolls always has
 * its search, and the picker stays small enough to open under the selector where it is.
 */
export const SEARCH_FROM = 5;

/** Whether the picker offers a search: only once there are enough repos to need one. */
export function showsSearch(count: number): boolean {
  return count >= SEARCH_FROM;
}

/**
 * Every repo the picker lists, in its order: the window's workspace's first (pushed-to lately
 * first, as given), then each other workspace's in the order the workspace switcher lists them.
 * A repo listed already (a workspace sharing one) is not listed twice. While the window's own
 * are loading, the others wait, and so does each other workspace's while one before it loads:
 * listed then, they would be pushed down when those arrive.
 */
export function pickerRepos(
  repos: readonly Repo[] | null,
  elsewhere: readonly RepoShelf[] = [],
): RepoRow[] {
  const seen = new Set<string>();
  const rows: RepoRow[] = [];
  const add = (repo: Repo, workspaceId: string | null) => {
    if (seen.has(repo.id)) return;
    seen.add(repo.id);
    rows.push({ repo, workspaceId });
  };
  if (repos === null) return rows;
  for (const repo of repos) add(repo, null);
  // In the switcher's order, up to the first still loading: one answering early waits for
  // those before it, so rows only ever join at the foot.
  for (const shelf of elsewhere) {
    if (shelf.repos === null) break;
    for (const repo of shelf.repos) add(repo, shelf.workspaceId);
  }
  return rows;
}

/**
 * The picker's rows for a query: Scratch, then the repos in the order given. A query keeps those
 * whose full name (`owner/name`) contains it anywhere, so an organization's name finds its repos.
 */
export function pickerRows(
  rows: readonly RepoRow[],
  query: string,
): { scratch: boolean; repos: RepoRow[] } {
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  return {
    scratch: matches("scratch"),
    repos: rows.filter((row) => matches(fullName(row.repo))),
  };
}

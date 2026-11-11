import type { Repo } from "../model.ts";

/** What a new design is made in: a repo, or Scratch. */
export type ProjectChoice = { kind: "repo"; repo: Repo } | { kind: "scratch" };

/** A prompt can be sent once it says something, and not twice while the first is going. */
export function canSend(prompt: string, sending: boolean): boolean {
  return !sending && prompt.trim().length > 0;
}

/**
 * The picker's search shows from this many repos: fewer read at a glance (with Scratch, at most
 * eight one-line rows), and the arrows reach them as fast as typing would.
 */
export const SEARCH_FROM = 8;

/** Whether the picker offers a search: only once there are enough repos to need one. */
export function showsSearch(repos: readonly Repo[] | null): boolean {
  return (repos?.length ?? 0) >= SEARCH_FROM;
}

/**
 * The picker's rows for a query: Scratch, then the repos in the order given (pushed-to lately
 * first). A query keeps those whose name contains it. Repos go by their name alone: they are the
 * workspace's, and a workspace is one GitHub account, so every one has the same owner.
 */
export function pickerRows(
  repos: readonly Repo[],
  query: string,
): { scratch: boolean; repos: Repo[] } {
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  return { scratch: matches("scratch"), repos: repos.filter((repo) => matches(repo.name)) };
}

import type { Repo } from "../model.ts";

/** What a new design is made in: a repo, or Scratch. */
export type ProjectChoice = { kind: "repo"; repo: Repo } | { kind: "scratch" };

/** A prompt can be sent once it says something, and not twice while the first is going. */
export function canSend(prompt: string, sending: boolean): boolean {
  return !sending && prompt.trim().length > 0;
}

/**
 * The picker's rows for a query: Scratch, then repos grouped by owner, each group in the order
 * given (pushed-to lately first). A query keeps rows whose name or owner/name contains it.
 */
export function pickerRows(
  repos: Repo[],
  query: string,
): { scratch: boolean; groups: { owner: string; repos: Repo[] }[] } {
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const groups: { owner: string; repos: Repo[] }[] = [];
  for (const repo of repos) {
    if (!matches(`${repo.owner}/${repo.name}`)) continue;
    const group = groups.find((g) => g.owner === repo.owner);
    if (group) group.repos.push(repo);
    else groups.push({ owner: repo.owner, repos: [repo] });
  }
  return { scratch: matches("scratch"), groups };
}

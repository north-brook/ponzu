import type { DesignSummary, Repo } from "./model.ts";

/**
 * The sidebar's filter: one person (or everyone) and a set of repos. `repos` null means every
 * repo, Scratch included; a list keeps only designs in those repos. There is no status filter.
 */
export interface DesignFilter {
  /** A person's id, or null for everyone. */
  person: string | null;
  repos: string[] | null;
}

export const NO_FILTER: DesignFilter = { person: null, repos: null };

export function isFiltering(filter: DesignFilter): boolean {
  return filter.person !== null || filter.repos !== null;
}

/** Whose a design is, for the person filter: the one who started it. */
export function applyFilter(designs: DesignSummary[], filter: DesignFilter): DesignSummary[] {
  return designs.filter((d) => {
    if (filter.person !== null && d.owner?.id !== filter.person) return false;
    if (filter.repos === null) return true;
    return d.project.kind === "repo" && filter.repos.includes(d.project.repo.id);
  });
}

/**
 * Checks or unchecks one repo out of `all`. Every repo checked is no filter at all, and so is
 * none: unchecking the last one would hide every design, which nobody means.
 */
export function toggleRepo(filter: DesignFilter, repoId: string, all: string[]): DesignFilter {
  const checked = filter.repos ?? all;
  const next = checked.includes(repoId)
    ? checked.filter((id) => id !== repoId)
    : all.filter((id) => id === repoId || checked.includes(id));
  const everyOrNone = next.length === 0 || all.every((id) => next.includes(id));
  return { ...filter, repos: everyOrNone ? null : next };
}

export function isRepoChecked(filter: DesignFilter, repoId: string): boolean {
  return filter.repos === null || filter.repos.includes(repoId);
}

export interface RepoCount {
  repo: Repo;
  count: number;
}

/** The repos that have designs, with how many, most first, then by name. */
export function repoCounts(designs: DesignSummary[]): RepoCount[] {
  const counts = new Map<string, RepoCount>();
  for (const d of designs) {
    if (d.project.kind !== "repo") continue;
    const { repo } = d.project;
    const entry = counts.get(repo.id) ?? { repo, count: 0 };
    entry.count++;
    counts.set(repo.id, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.repo.name.localeCompare(b.repo.name),
  );
}

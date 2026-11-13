import type { CanvasSummary, Project, Repo } from "./model.ts";

/**
 * The sidebar's filter: one person (or everyone) and a set of projects, each a repo or Scratch.
 * `projects` null means all of them; a list keeps only canvases in those. There is no status
 * filter.
 */
export interface CanvasFilter {
  /** A person's id, or null for everyone. */
  person: string | null;
  /** Project keys (see `projectKey`), or null for every project. */
  projects: string[] | null;
}

export const NO_FILTER: CanvasFilter = { person: null, projects: null };

/** Scratch's key among the projects: every Scratch canvas, whatever its city. */
export const SCRATCH = "scratch";

/** A repo's key is `repo:` and its id, so no repo can be taken for Scratch. */
export function repoKey(repo: Repo): string {
  return `repo:${repo.id}`;
}

export function projectKey(project: Project): string {
  return project.kind === "repo" ? repoKey(project.repo) : SCRATCH;
}

export function isFiltering(filter: CanvasFilter): boolean {
  return filter.person !== null || filter.projects !== null;
}

/** Whose a canvas is, for the person filter: the one who started it. */
export function applyFilter(canvases: CanvasSummary[], filter: CanvasFilter): CanvasSummary[] {
  return canvases.filter((d) => {
    if (filter.person !== null && d.owner?.id !== filter.person) return false;
    return filter.projects === null || filter.projects.includes(projectKey(d.project));
  });
}

/**
 * Checks or unchecks one project out of `all`. Every project checked is no filter at all, and
 * so is none: unchecking the last one would hide every canvas, which nobody means.
 */
export function toggleProject(filter: CanvasFilter, key: string, all: string[]): CanvasFilter {
  const checked = filter.projects ?? all;
  const next = checked.includes(key)
    ? checked.filter((k) => k !== key)
    : all.filter((k) => k === key || checked.includes(k));
  const everyOrNone = next.length === 0 || all.every((k) => next.includes(k));
  return { ...filter, projects: everyOrNone ? null : next };
}

export function isProjectChecked(filter: CanvasFilter, key: string): boolean {
  return filter.projects === null || filter.projects.includes(key);
}

export interface ProjectCount {
  key: string;
  /** Null for Scratch. */
  repo: Repo | null;
  count: number;
}

/** The projects that have canvases, with how many: repos most first, then by name; Scratch last. */
export function projectCounts(canvases: CanvasSummary[]): ProjectCount[] {
  const counts = new Map<string, ProjectCount>();
  for (const d of canvases) {
    const key = projectKey(d.project);
    const entry = counts.get(key) ?? {
      key,
      repo: d.project.kind === "repo" ? d.project.repo : null,
      count: 0,
    };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort(
    (a, b) =>
      Number(a.repo === null) - Number(b.repo === null) ||
      b.count - a.count ||
      (a.repo?.name ?? "").localeCompare(b.repo?.name ?? ""),
  );
}

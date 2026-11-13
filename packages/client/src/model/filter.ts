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

/**
 * A filter as storage held it, checked field by field: anything that isn't one counts as none
 * (a person that isn't an id is everyone; projects that aren't a list are every project, and
 * keys that aren't strings are dropped).
 */
export function readFilter(value: unknown): CanvasFilter {
  const f = value && typeof value === "object" ? (value as Partial<CanvasFilter>) : null;
  const person = typeof f?.person === "string" ? f.person : null;
  const projects = Array.isArray(f?.projects)
    ? f.projects.filter((p): p is string => typeof p === "string")
    : null;
  return { person, projects };
}

/**
 * The filter as it applies to what the workspace holds now. A filter kept from before can name a
 * project no canvas is in any more, or a person no longer offered: those are dropped, so it never
 * hides every canvas for a reason the filter can't show. Projects left covering every one, or
 * none, are no project filter, as `toggleProject` has it. `people` null is not known yet: the
 * person stays. Unchanged, it is the same filter.
 */
export function pruneFilter(
  filter: CanvasFilter,
  projects: readonly string[],
  people: readonly string[] | null,
): CanvasFilter {
  const person =
    filter.person !== null && people !== null && !people.includes(filter.person)
      ? null
      : filter.person;
  let kept = filter.projects;
  if (kept !== null) {
    const live = kept.filter((k) => projects.includes(k));
    const everyOrNone = live.length === 0 || projects.every((k) => live.includes(k));
    kept = everyOrNone ? null : live.length === kept.length ? kept : live;
  }
  return person === filter.person && kept === filter.projects ? filter : { person, projects: kept };
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

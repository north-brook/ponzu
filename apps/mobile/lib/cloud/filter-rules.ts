import { type CanvasFilter, isFiltering } from "@ponzu/client/model";

/*
 * How the canvases list's filter is kept (lib/cloud/filter.ts), pure: per person, a filter for
 * each workspace, as the Mac keeps one for each workspace in its window state (studio
 * ui-state.ts).
 */

/**
 * A filter as storage held it, checked field by field: anything that isn't one counts as none
 * (a person that isn't an id is everyone; projects that aren't a list are every project, and
 * keys that aren't strings are dropped). The same reading as the Mac's (studio ui-state.ts).
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

/** Where a person's filters are kept: one JSON object, by workspace id. Not a secret. */
export const filterKey = (userId: string) => `ponzu.filter.${userId}`;

/** What storage held, checked field by field: anything else counts as no filter. */
export function readFilters(raw: string | null): Record<string, CanvasFilter> {
  let saved: unknown = null;
  try {
    saved = JSON.parse(raw ?? "null");
  } catch {}
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const filters: Record<string, CanvasFilter> = {};
  for (const [id, value] of Object.entries(saved)) {
    const filter = readFilter(value);
    if (isFiltering(filter)) filters[id] = filter;
  }
  return filters;
}

/** `filters` with `workspaceId`'s set to `filter`; no filter is kept as nothing. */
export function withFilter(
  filters: Readonly<Record<string, CanvasFilter>>,
  workspaceId: string,
  filter: CanvasFilter,
): Record<string, CanvasFilter> {
  const next = { ...filters };
  if (isFiltering(filter)) next[workspaceId] = filter;
  else delete next[workspaceId];
  return next;
}

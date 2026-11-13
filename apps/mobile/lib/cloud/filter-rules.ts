import { type CanvasFilter, isFiltering, readFilter } from "@ponzu/client/model";

/*
 * How the canvases list's filter is kept (lib/cloud/filter.ts), pure: per person, a filter for
 * each workspace, as the Mac keeps one for each workspace in its window state (studio
 * ui-state.ts).
 */

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

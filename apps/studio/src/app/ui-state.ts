import { type DesignFilter, NO_FILTER } from "../cloud/filter.ts";
import { PANES, paneWidth } from "../cloud/window/panes.ts";

/*
 * What the window remembers between launches, for one person on this computer: the workspace
 * they were in, the design open in each, the sidebar and rail (open or not, and how wide), and
 * each workspace's filter.
 * Kept in localStorage, which can be full, cleared or unavailable: then it is simply forgotten,
 * never an error.
 */

export interface UiState {
  workspaceId: string | null;
  /** The design last open in each workspace. Absent: its create page. */
  designs: Record<string, string>;
  sidebarOpen: boolean;
  railOpen: boolean;
  /** Each pane's width as the person last dragged it, which it opens at again (panes.ts). */
  sidebarWidth: number;
  railWidth: number;
  filters: Record<string, DesignFilter>;
}

export const DEFAULT_UI: UiState = {
  workspaceId: null,
  designs: {},
  sidebarOpen: true,
  railOpen: true,
  sidebarWidth: PANES.sidebar.default,
  railWidth: PANES.rail.default,
  filters: {},
};

type Store = Pick<Storage, "getItem" | "setItem">;

const key = (personId: string) => `ponzu.ui.${personId}`;

export function loadUi(personId: string, store: Store | null = safeLocalStorage()): UiState {
  let saved: unknown = null;
  try {
    saved = JSON.parse(store?.getItem(key(personId)) ?? "null");
  } catch {}
  if (!saved || typeof saved !== "object") return DEFAULT_UI;
  const s = saved as Partial<Record<keyof UiState, unknown>>;
  return {
    workspaceId: typeof s.workspaceId === "string" ? s.workspaceId : null,
    designs: stringRecord(s.designs),
    sidebarOpen: typeof s.sidebarOpen === "boolean" ? s.sidebarOpen : DEFAULT_UI.sidebarOpen,
    railOpen: typeof s.railOpen === "boolean" ? s.railOpen : DEFAULT_UI.railOpen,
    sidebarWidth: paneWidth("sidebar", s.sidebarWidth),
    railWidth: paneWidth("rail", s.railWidth),
    filters: filterRecord(s.filters),
  };
}

export function saveUi(personId: string, ui: UiState, store: Store | null = safeLocalStorage()) {
  try {
    store?.setItem(key(personId), JSON.stringify(ui));
  } catch {}
}

export function filterFor(ui: UiState, workspaceId: string): DesignFilter {
  return ui.filters[workspaceId] ?? NO_FILTER;
}

function safeLocalStorage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function filterRecord(value: unknown): Record<string, DesignFilter> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const filters: Record<string, DesignFilter> = {};
  for (const [id, filter] of Object.entries(value)) {
    const f = filter as Partial<DesignFilter> | null;
    const person = typeof f?.person === "string" ? f.person : null;
    const projects = Array.isArray(f?.projects)
      ? f.projects.filter((p): p is string => typeof p === "string")
      : null;
    filters[id] = { person, projects };
  }
  return filters;
}

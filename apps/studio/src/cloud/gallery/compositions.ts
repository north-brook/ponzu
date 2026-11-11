/*
 * The gallery's full-window compositions: what each is, its size, and how it is compared. The
 * React for each is in boards.tsx; this file stays free of it so the visual scripts can read it.
 *
 * - `board` names the design's artboard file (under its pages/ folder) it is compared with.
 * - `open` is a control pressed before the picture: a menu or a popover's trigger.
 * - `masks` cover what the gallery doesn't draw: the canvas's boards, and on the sidebar's
 *   boards the thread rail, which their compositions leave empty.
 * - `reference` draws it for the visual regression test, from references/.
 * - `differs` says where the app departs from the board on purpose; `compare` prints it, and a
 *   mask over that part keeps the share outside the masks about the rest.
 */
import { SETUP_COMPOSITIONS } from "./setup-compositions.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Composition {
  id: string;
  title: string;
  board?: string;
  width: number;
  height: number;
  open?: string;
  masks?: Rect[];
  reference?: boolean;
  differs?: string;
}

/**
 * The window's 44px chrome, across its width. Masked in every comparison with the design's
 * boards (visual.ts adds it): it departs from them on purpose, with no lockup and the toggles
 * at the window's edges (README, "The window chrome").
 */
export const CHROME_HEIGHT = 44;

const CANVAS: Rect = { x: 300, y: 44, width: 780, height: 850 };
const RAIL: Rect = { x: 1080, y: 44, width: 360, height: 856 };
const DESIGN = [CANVAS, RAIL];
const WINDOW = { width: 1440, height: 900 };

export const COMPOSITIONS: Composition[] = [
  {
    id: "team-sidebar",
    title: "Team sidebar",
    board: "teams/team-sidebar.html",
    ...WINDOW,
    masks: DESIGN,
    reference: true,
  },
  {
    id: "sidebar-team-menu",
    title: "Sidebar · Team menu",
    board: "mac/sidebar-team-menu.html",
    ...WINDOW,
    open: 'button[aria-label^="Workspace"]',
    masks: DESIGN,
    reference: true,
  },
  {
    id: "sidebar-filter",
    title: "Sidebar · Filter",
    board: "mac/sidebar-filter.html",
    ...WINDOW,
    open: 'button[aria-label^="Filter"]',
    masks: DESIGN,
    reference: true,
  },
  {
    id: "sidebar-search",
    title: "Sidebar · Search",
    board: "mac/sidebar-search.html",
    ...WINDOW,
    masks: DESIGN,
  },
  {
    id: "sidebar-search-results",
    title: "Sidebar · Search results",
    board: "mac/sidebar-search-results.html",
    ...WINDOW,
    masks: DESIGN,
    reference: true,
  },
  {
    id: "share",
    title: "Share",
    board: "teams/share.html",
    ...WINDOW,
    open: 'button[aria-label="Share"]',
    masks: DESIGN,
    reference: true,
  },
  {
    id: "thread-in-the-right-rail",
    title: "1 · Thread in the right rail",
    board: "mac/1-thread-in-the-right-rail.html",
    ...WINDOW,
    masks: [CANVAS],
    reference: true,
  },
  {
    id: "claude-sets-it-up",
    title: "6 · Claude sets it up",
    board: "mac/6-claude-sets-it-up.html",
    ...WINDOW,
    masks: [CANVAS],
  },
  { id: "create", title: "4 · Create", board: "mac/4-create.html", ...WINDOW, reference: true },
  {
    id: "pick-a-project",
    title: "5 · Pick a project",
    board: "mac/5-pick-a-project.html",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    // The board's picker and ours, wherever either lands.
    masks: [{ x: 530, y: 416, width: 424, height: 380 }],
    differs:
      "the picker's rows are one line (no owner/name or note under them, no owner heading), the search shows only from eight repos, and Scratch has the temporary-folder icon",
    reference: true,
  },
  {
    id: "pick-a-project-scratch",
    title: "Pick a project · Scratch chosen",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
  },
  {
    id: "pick-a-project-one-repo",
    title: "Pick a project · one repo",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    reference: true,
  },
  {
    id: "pick-a-project-many-repos",
    title: "Pick a project · fifteen repos",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    reference: true,
  },
  {
    id: "fresh-start",
    title: "5 · Fresh start",
    board: "onboarding/5-fresh-start.html",
    ...WINDOW,
    reference: true,
  },
  { id: "fresh-start-personal", title: "Fresh start · a new personal workspace", ...WINDOW },
  { id: "fresh-start-no-repos", title: "Fresh start · no repos yet", ...WINDOW },
  { id: "fresh-start-loading", title: "Fresh start · loading", ...WINDOW },
  { id: "sidebar-collapsed", title: "Sidebar collapsed, rail closed", ...WINDOW },
  { id: "settled-open", title: "Settled tray expanded", ...WINDOW },
  { id: "filtered-empty", title: "A filter nothing matches", ...WINDOW },
  {
    id: "needs-you-a-question",
    title: "2 · Needs you: a question",
    board: "mac/2-needs-you-a-question.html",
    ...WINDOW,
    open: '[role="radio"]:has-text("Shorten it")',
    masks: [CANVAS],
    reference: true,
  },
  {
    id: "pull-request-tab",
    title: "3 · Pull request tab",
    board: "mac/3-pull-request-tab.html",
    ...WINDOW,
    open: 'button[aria-controls="file-src/components/hero.tsx"]',
    reference: true,
  },
  {
    id: "together-on-a-design",
    title: "Together on a design",
    board: "teams/together-on-a-design.html",
    ...WINDOW,
    masks: [CANVAS],
    reference: true,
  },
  {
    id: "crowded-chrome",
    title: "Chrome · five people and Update branch, rail open",
    ...WINDOW,
    reference: true,
  },
  {
    id: "crowded-chrome-closed",
    title: "Chrome · five people and Update branch, rail closed",
    ...WINDOW,
  },
  { id: "long-thread", title: "Thread · a thousand lines, older ones loading", ...WINDOW },
  { id: "thread-loading", title: "Thread · loading", ...WINDOW },
  { id: "thread-every-kind", title: "Thread · every kind of line", ...WINDOW },
  { id: "thread-read-only", title: "Thread · read-only access", ...WINDOW },
  { id: "pull-request-busy", title: "Pull request · draft, failing, large files", ...WINDOW },
  { id: "pull-request-merged", title: "Pull request · merged", ...WINDOW },
  {
    id: "pull-request-one-file",
    title: "Pull request · merged, one file, no checks, a long branch",
    ...WINDOW,
  },
  { id: "pull-request-loading", title: "Pull request · loading", ...WINDOW },
  { id: "pull-request-error", title: "Pull request · GitHub unreachable", ...WINDOW },
  ...SETUP_COMPOSITIONS,
];

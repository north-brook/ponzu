/*
 * The gallery's full-window compositions: what each is, its size, and how it is compared. The
 * React for each is in boards.tsx; this file stays free of it so the visual scripts can read it.
 *
 * - `board` names the mockup's artboard file (under its pages/ folder) it is compared with.
 * - `open` is a control pressed before the picture: a menu or a popover's trigger.
 * - `masks` cover what the gallery doesn't draw: the canvas's boards, and on the sidebar's
 *   boards the thread rail, which their compositions leave empty.
 * - `reference` draws it for the visual regression test, from references/: its painted styles in
 *   both themes, and its picture in light. `"styles"` keeps only the styles, for a composition
 *   whose layout another's picture already holds.
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
  reference?: boolean | "styles";
  differs?: string;
}

/**
 * The chrome as the mockup's boards draw it, 44px across the window's width. Masked in every
 * comparison with the boards (visual.ts adds it): ours departs from them on purpose, with no
 * lockup, the toggles at the window's edges, and 38px tall (README, "The window chrome"), which
 * this covers too. Under it, everything of ours sits 6px higher than on a board.
 */
export const CHROME_HEIGHT = 44;

/** The panes under our 38px chrome. */
const MAIN: Rect = { x: 300, y: 38, width: 780, height: 856 };
const RAIL: Rect = { x: 1080, y: 38, width: 360, height: 862 };
const CANVAS = [MAIN, RAIL];
const WINDOW = { width: 1440, height: 900 };
/** MIN_WINDOW in app-window.tsx, which this file can't import (it stays free of React). */
const MIN = { width: 1100, height: 640 };

export const COMPOSITIONS: Composition[] = [
  {
    id: "team-sidebar",
    title: "Team sidebar",
    board: "teams/team-sidebar.html",
    ...WINDOW,
    masks: CANVAS,
    reference: true,
  },
  {
    id: "sidebar-team-menu",
    title: "Sidebar · Team menu",
    board: "mac/sidebar-team-menu.html",
    ...WINDOW,
    open: 'button[aria-label^="Workspace"]',
    masks: CANVAS,
    reference: true,
  },
  {
    id: "sidebar-filter",
    title: "Sidebar · Filter",
    board: "mac/sidebar-filter.html",
    ...WINDOW,
    open: 'button[aria-label^="Filter"]',
    masks: CANVAS,
    reference: true,
  },
  {
    id: "sidebar-search",
    title: "Sidebar · Search",
    board: "mac/sidebar-search.html",
    ...WINDOW,
    masks: CANVAS,
  },
  {
    id: "sidebar-search-results",
    title: "Sidebar · Search results",
    board: "mac/sidebar-search-results.html",
    ...WINDOW,
    masks: CANVAS,
    reference: true,
  },
  {
    id: "sidebar-previews-updating",
    title: "Sidebar · Previews updating while the agent works",
    ...WINDOW,
  },
  {
    // For the tests and a look: a canvas opening with its answers late, delivered on demand
    // (`window.galleryArrive`, or `?later` on a schedule). Its first paint: the row's mark, the
    // action's room held, you alone, no pages yet.
    id: "canvas-opening",
    title: "Opening a canvas · its answers arriving late",
    ...WINDOW,
  },
  {
    id: "canvas-opening-launch",
    title: "Opening a canvas at launch · nothing known yet, the sidebar collapsed",
    ...WINDOW,
  },
  {
    id: "share",
    title: "Share",
    board: "teams/share.html",
    ...WINDOW,
    open: 'button[aria-label="Share"]',
    masks: CANVAS,
    reference: true,
  },
  {
    // Not drawn: two people GitHub gives access to who haven't opened Ponzu yet, quieter. The
    // rows are share's; the styles hold who is listed and how quiet they are.
    id: "share-not-joined",
    title: "Share · some haven't opened Ponzu",
    ...WINDOW,
    open: 'button[aria-label="Share"]',
    masks: CANVAS,
    reference: "styles",
  },
  {
    id: "thread-in-the-right-rail",
    title: "1 · Thread in the right rail",
    board: "mac/1-thread-in-the-right-rail.html",
    ...WINDOW,
    masks: [MAIN],
    reference: true,
  },
  {
    id: "claude-sets-it-up",
    title: "6 · Claude sets it up",
    board: "mac/6-claude-sets-it-up.html",
    ...WINDOW,
    masks: [MAIN],
  },
  { id: "create", title: "4 · Create", board: "mac/4-create.html", ...WINDOW, reference: true },
  {
    // The model and effort, two panes side by side, opening upward from the docked composer.
    id: "create-model-menu",
    title: "Create · the model and effort menu",
    ...WINDOW,
    open: 'button[aria-label^="Model"]',
    reference: true,
  },
  {
    id: "pick-a-project",
    title: "5 · Pick a project",
    board: "mac/5-pick-a-project.html",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    // The board's picker (under the composer) and ours (under the header's selector).
    masks: [{ x: 530, y: 380, width: 700, height: 420 }],
    differs:
      "the project selector is in the header beside the logo, not a chip under the composer; the picker's rows are one line titled owner/name (no note under them, no owner heading), grouped under each workspace's name with its own Scratch when there are several, the search shows whenever the list of five and a half rows would scroll, and Scratch has the dashed-folder icon",
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
    id: "pick-a-project-workspaces",
    title: "Pick a project · two workspaces",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    reference: true,
  },
  {
    // Bramble School's heading and Scratch are there at once; its repos haven't arrived. Its
    // group is under the fold, so the picture would be pick-a-project-workspaces': the styles
    // hold its heading, its Scratch and the place kept for its repos.
    id: "pick-a-project-workspaces-loading",
    title: "Pick a project · two workspaces, the second's repos still coming",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
    reference: "styles",
  },
  {
    // For the tests: which workspace's late repos join an open list (`?later`).
    id: "pick-a-project-three-workspaces",
    title: "Pick a project · three workspaces",
    ...WINDOW,
    open: 'button[aria-label^="Project"]',
  },
  {
    id: "fresh-start-long-name",
    title: "Fresh start · a long owner and name",
    ...WINDOW,
    reference: true,
  },
  {
    id: "fresh-start",
    title: "5 · Fresh start",
    board: "onboarding/5-fresh-start.html",
    ...WINDOW,
    reference: true,
    differs:
      "the mark over a statement ending in the project selector stands where the board's question is, centred in the room above a composer docked at the pane's foot; the ideas take turns as the composer's placeholder instead of tiles under it, and the page has the canvas's dots",
  },
  {
    // The create page in a short window and a tall one: the hero centred in the room above the
    // composer at each, the composer on the pane's foot.
    id: "fresh-start-short",
    title: "Fresh start · a short window",
    width: 1440,
    height: 700,
    reference: true,
  },
  {
    id: "fresh-start-tall",
    title: "Fresh start · a tall window",
    width: 1440,
    height: 1200,
    reference: true,
  },
  {
    // Sent: the composer travels to the thread, which closes after a beat (gallery.create.test.ts).
    id: "create-send",
    title: "Create · sending: the composer goes to the thread",
    ...WINDOW,
  },
  { id: "fresh-start-personal", title: "Fresh start · a new personal workspace", ...WINDOW },
  {
    // Scratch: the statement on one line, in the two lines' room a repo takes.
    id: "fresh-start-no-repos",
    title: "Fresh start · no repos yet",
    ...WINDOW,
    reference: true,
  },
  { id: "fresh-start-loading", title: "Fresh start · loading", ...WINDOW },
  { id: "sidebar-collapsed", title: "Sidebar collapsed, rail closed", ...WINDOW, reference: true },
  {
    id: "sidebar-collapsed-long-name",
    title: "Sidebar collapsed · a long canvas name",
    ...WINDOW,
    reference: true,
  },
  { id: "min-window", title: "The smallest window", ...MIN, reference: true },
  {
    id: "min-window-collapsed",
    title: "The smallest window · sidebar collapsed",
    ...MIN,
    reference: true,
  },
  { id: "settled-open", title: "Settled tray expanded", ...WINDOW },
  { id: "filtered-empty", title: "A filter nothing matches", ...WINDOW },
  {
    id: "needs-you-a-question",
    title: "2 · Needs you: a question",
    board: "mac/2-needs-you-a-question.html",
    ...WINDOW,
    open: '[role="radio"]:has-text("Shorten it")',
    masks: [MAIN],
    reference: true,
  },
  {
    id: "pull-request-tab",
    title: "3 · Pull request tab",
    board: "mac/3-pull-request-tab.html",
    ...WINDOW,
    open: 'button[aria-controls="file-src/components/hero.tsx"]',
    masks: CANVAS,
    reference: true,
    differs:
      "the tab no longer folds the thread away: the rail stays as it was (open here), and the pull request fits the canvas's column, stacked at this width (both masked)",
  },
  {
    id: "together-on-a-canvas",
    title: "Together on a canvas",
    board: "teams/together-on-a-design.html",
    ...WINDOW,
    masks: [MAIN],
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
    reference: true,
  },
  {
    id: "crowded-chrome-min-window",
    title: "Chrome · five people and Update branch, the smallest window",
    ...MIN,
    // No reference picture: the page tabs take whatever the cluster leaves, so a pixel of
    // difference in how a platform sets "Update branch" moves the tabs' edge, the fade and the
    // "+", past the picture's tolerance on Linux. chrome.test.ts holds its layout by measure.
  },
  { id: "long-thread", title: "Thread · a thousand lines, older ones loading", ...WINDOW },
  { id: "thread-loading", title: "Thread · loading", ...WINDOW },
  { id: "thread-every-kind", title: "Thread · every kind of line", ...WINDOW },
  { id: "thread-read-only", title: "Thread · read-only access", ...WINDOW },
  { id: "turn-running", title: "Turn · running, drawing a board", ...WINDOW },
  { id: "turn-running-thinking", title: "Turn · running, thinking", ...WINDOW },
  { id: "turn-running-command", title: "Turn · running, a long command", ...WINDOW },
  { id: "turn-completed", title: "Turn · completed, only its answer", ...WINDOW },
  { id: "turn-stopped", title: "Turn · stopped", ...WINDOW },
  { id: "turn-failed", title: "Turn · failed", ...WINDOW },
  { id: "turn-asked", title: "Turn · ended on a question", ...WINDOW },
  { id: "turn-old-runner", title: "Turn · an older runner's thread", ...WINDOW },
  { id: "pull-request-busy", title: "Pull request · draft, failing, large files", ...WINDOW },
  { id: "pull-request-merged", title: "Pull request · merged", ...WINDOW },
  {
    id: "pull-request-one-file",
    title: "Pull request · merged, one file, no checks, a long branch",
    ...WINDOW,
  },
  {
    id: "pull-request-rail-closed",
    title: "Pull request · the thread closed: two columns",
    ...WINDOW,
    reference: true,
  },
  {
    id: "pull-request-min-window",
    title: "Pull request · the smallest window, both panes open, a long title",
    ...MIN,
    reference: true,
  },
  {
    id: "pull-request-wide",
    title: "Pull request · a wide screen, the sidebar closed",
    width: 2240,
    height: 1100,
  },
  { id: "pull-request-loading", title: "Pull request · loading", ...WINDOW },
  { id: "pull-request-error", title: "Pull request · GitHub unreachable", ...WINDOW },
  ...SETUP_COMPOSITIONS,
];

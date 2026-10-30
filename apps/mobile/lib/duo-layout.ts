/**
 * How the canvas screen is laid out, from the window and the hinge alone,
 * as Apple asks of iPhone Duo: by the space there is, never by the model or
 * the pose's name. The app is portrait-only (app.json), which every iPhone
 * keeps to; only iPhone Duo's inner display turns with the hand whatever the
 * app asks, so only there is the window ever wider than tall.
 *
 * - `phone`: an iPhone, and iPhone Duo closed (its outer display). The bars
 *   are the canvas's own: Back, the file, the page. Comments are the sheet.
 * - `rail`: a window wide enough that the system puts its bars on a rail at
 *   the trailing edge (the outer display, and the inner one held sideways).
 *   Back and comments at its top, and the page, are the rail's native items.
 * - `upright`: the inner display held upright: horizontal bars, Back and
 *   the file top left, the page top right, comments bottom right.
 *
 * Partly open, the design keeps one half and comments take the other
 * (`split`): `below` held upright (like a laptop), `beside` held sideways
 * (like a book). Flat, comments are the sheet (`phone`, `upright`) or an
 * inset panel (`rail`, the inner display sideways).
 */
export interface DuoLayout {
  bars: "phone" | "rail" | "upright";
  /** Comments always there, past the fold, or null when the design has the display. */
  split: "below" | "beside" | null;
  /** Comments as a floating panel beside the canvas (open sideways), rather than the sheet. */
  panel: boolean;
}

/** The narrowest window that's iPhone Duo's inner display: wider than any iPhone. */
const INNER = 600;

export function duoLayout(
  window: { width: number; height: number },
  /** The system's rail is there: the safe area's trailing inset is wider than the status bar's height. */
  rail: boolean,
  /** The hinge is partly open (expo-hinge `partiallyOpen`). */
  folded: boolean,
): DuoLayout {
  const { width, height } = window;
  const inner = Math.min(width, height) >= INNER;
  const sideways = width > height;
  if (inner && folded) {
    return {
      bars: sideways ? "rail" : "upright",
      split: sideways ? "beside" : "below",
      panel: false,
    };
  }
  if (inner) {
    return sideways
      ? { bars: "rail", split: null, panel: true }
      : { bars: "upright", split: null, panel: false };
  }
  return { bars: rail ? "rail" : "phone", split: null, panel: false };
}

/**
 * The band either side of the fold where nothing to tap sits while the
 * hinge is partly open, as augmenter's `CREASE`: 12pt each side, 24 in all.
 * It's kept clear, never painted: the two halves meet at the fold itself,
 * as the system's own split does.
 */
export const CREASE = 12;

/**
 * The comment sheet's widest. Held sideways the inner display is 950pt and
 * more, too wide for a sheet across it: there it floats over the canvas,
 * centred, at most this wide, and rides the keyboard rather than docking
 * on it. Everywhere else it spans the screen, as on an iPhone.
 */
export const SHEET_MAX = 560;

/** The comment sheet's widest for a layout (`SHEET_MAX`), or undefined where it spans the screen. */
export function sheetMax(layout: DuoLayout): number | undefined {
  return layout.panel || layout.split === "beside" ? SHEET_MAX : undefined;
}

/**
 * Where comments' button sits among the system's bar items: on the rail it
 * joins Back at the top; upright, bottom right as an iPhone's toolbar has
 * it. Folded there's none, comments being their own half, and a phone's
 * bars are the canvas's own.
 */
export function commentsButton(layout: DuoLayout): "rail" | "toolbar" | null {
  if (layout.split || layout.bars === "phone") return null;
  return layout.bars === "rail" ? "rail" : "toolbar";
}

/** Where the fold falls on the window, along the axis it divides. */
export function foldAt(window: { width: number; height: number }, split: DuoLayout["split"]) {
  return split === "beside" ? window.width / 2 : window.height / 2;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The two halves, partly open. The design's is what the canvas frames its
 * boards in, stopping short of the crease. The comments half is full bleed
 * from the fold itself to the window's far edges, the rail's side included,
 * so nothing but the two halves meets at the fold; it keeps what it holds
 * `CREASE` clear of the fold.
 */
export function halves(
  window: { width: number; height: number },
  split: "beside" | "below",
): { canvas: Rect; comments: Rect } {
  const { width, height } = window;
  const fold = foldAt(window, split);
  return split === "beside"
    ? {
        canvas: { left: 0, top: 0, width: fold - CREASE, height },
        comments: { left: fold, top: 0, width: width - fold, height },
      }
    : {
        canvas: { left: 0, top: 0, width, height: fold - CREASE },
        comments: { left: 0, top: fold, width, height: height - fold },
      };
}

/**
 * How many columns of design cards fit the page's width (the window less
 * the rail): two on an iPhone and the outer display, three on the inner
 * display (the board's 7 upright, and beside the rail sideways).
 */
export function designColumns(width: number): number {
  return width >= INNER - 20 ? 3 : 2;
}

/**
 * Whether the system's bars are a rail at the side: the safe area's
 * leading or trailing inset is the rail's width (84pt measured on the
 * simulator), wider than any iPhone's landscape notch inset would be here.
 */
export function hasRail(insets: { left: number; right: number }): boolean {
  return Math.max(insets.left, insets.right) >= RAIL_MIN;
}
const RAIL_MIN = 60;

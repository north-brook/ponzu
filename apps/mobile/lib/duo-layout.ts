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
 *   Back, the page and comments are the rail's native items.
 * - `upright`: the inner display held upright and flat: horizontal bars,
 *   Back top left, the page top right, comments bottom right.
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
 */
export const CREASE = 12;

/** Where the fold falls on the window, along the axis it divides. */
export function foldAt(window: { width: number; height: number }, split: DuoLayout["split"]) {
  return split === "beside" ? window.width / 2 : window.height / 2;
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

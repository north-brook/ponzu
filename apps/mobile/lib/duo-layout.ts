/**
 * How the canvas screen is laid out, from the window and the hinge alone,
 * as Apple asks of iPhone Duo and iPad: by the space there is, never by the
 * model or the pose's name. An iPhone keeps to portrait (app.json); iPhone
 * Duo's inner display turns with the hand whatever the app asks, and an iPad
 * turns and sizes its windows freely, so only there is the window ever wider
 * than tall.
 *
 * - `phone`: an iPhone, iPhone Duo closed (its outer display), and an iPad
 *   window as narrow as one. The bars are the canvas's own: Back, the file,
 *   the page. Comments are the sheet.
 * - `rail`: a window wide enough that the system puts its bars on a rail at
 *   the trailing edge (the outer display, and the inner one held sideways).
 *   Back and comments at its top, and the page, are the rail's native items.
 * - `upright`: horizontal system bars over a wide window: the inner display
 *   held upright, and an iPad either way up. Back and the file top left, the
 *   page top right, comments bottom right.
 *
 * Partly open, the design keeps one half and comments take the other
 * (`split`): `below` held upright (like a laptop), `beside` held sideways
 * (like a book). Flat, comments are the sheet or, in a window wide enough
 * for both (the inner display sideways, an iPad sideways or a large one
 * upright), an inset panel beside the canvas.
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
/** The narrowest window with room for the comments panel (344pt) beside the canvas. */
const PANEL = 900;

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
    // Sideways, iPhone Duo's bars are a rail at the side; an iPad's stay across the top.
    return {
      bars: sideways && rail ? "rail" : "upright",
      split: null,
      // Sideways with the rail, the inner display has room for it; elsewhere it takes the width.
      panel: (sideways && rail) || width >= PANEL,
    };
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
 * more, too wide for a sheet across it, and an iPad is wider still: there it
 * floats over the canvas, centred, at most this wide, and rides the keyboard
 * rather than docking on it. Everywhere else it spans the screen, as on an
 * iPhone.
 */
export const SHEET_MAX = 560;

/**
 * The comment sheet's widest for a layout (`SHEET_MAX`), or undefined where it spans the screen.
 * A window `WIDE_SHEET` or wider floats it too (an iPad's, upright as well as sideways); iPhone
 * Duo's inner display upright, at 669pt, keeps the sheet across it.
 */
export function sheetMax(layout: DuoLayout, width: number): number | undefined {
  return layout.panel || layout.split === "beside" || (!layout.split && width >= WIDE_SHEET)
    ? SHEET_MAX
    : undefined;
}
const WIDE_SHEET = 700;

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
 * the rail), less its 16pt margins and the 16pt between cards: two on an
 * iPhone and the outer display; three once each can be 200pt, as on the
 * inner display (the board's 7 upright, and beside the rail sideways); and
 * more as long as each stays `CARD` or wider (an iPad's four or five).
 */
export function designColumns(width: number): number {
  const fits = (n: number, min: number) => (width - 2 * 16 - 16 * (n - 1)) / n >= min;
  if (!fits(3, 200)) return 2;
  let n = 3;
  while (fits(n + 1, CARD)) n++;
  return n;
}
/** The narrowest a card gets once there are more than three columns. */
const CARD = 230;

/**
 * Whether the system's bars are a rail at the side: the safe area's
 * leading or trailing inset is the rail's width (84pt measured on the
 * simulator), wider than any iPhone's landscape notch inset would be here.
 */
export function hasRail(insets: { left: number; right: number }): boolean {
  return Math.max(insets.left, insets.right) >= RAIL_MIN;
}
const RAIL_MIN = 60;

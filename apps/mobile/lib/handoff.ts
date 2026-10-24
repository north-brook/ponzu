import { EASE_OUT } from "./tokens";

/**
 * The launch screen's handoff to the first screen, timed as the design's
 * motion studies have it (Connect › Launch → Tailscale off, Launch →
 * Designs). One clock counts milliseconds from the moment the launch
 * wordmark starts to leave; each part moves over its own stretch of it on
 * its own curve. Worklets, so the UI thread reads them every frame; pure,
 * so tests run them.
 */
export type Span = readonly [number, number];
export type Curve = readonly [number, number, number, number];

export const CURVES = {
  /** `--ease-out`, cubic-bezier(0.2, 0.8, 0.2, 1). */
  out: EASE_OUT,
  /** CSS `ease-in`. */
  in: [0.42, 0, 1, 1],
  /** CSS `ease`. */
  ease: [0.25, 0.1, 0.25, 1],
} as const satisfies Record<string, Curve>;

/**
 * Launch → Connect, Needs Tailscale and Macs not answering: the yuzu screen
 * shrinks into the 64pt tile at its place in the marks row (corners 55 →
 * 16), the slice flies from the launch screen's middle into the tile, the
 * wordmark sinks and fades, then the screen's content rises in. The study
 * loops in 4s; its handoff starts at 16%, so each stretch is (% − 16) × 40ms.
 */
export const TO_TILE = {
  /** wordout 16% → 28%, `ease`: fades, 8pt down. */
  word: [0, 480],
  /** shrink and fly 20% → 48%, ease-out. */
  shrink: [160, 1280],
  /** The status bar turns from the launch's ink to the screen's, 24% → 44%. */
  ink: [320, 1120],
  /** later 38% → 56%, ease-out: the content and actions rise 12pt and fade in. */
  rise: [880, 1600],
  end: 1600,
} as const;

/**
 * Launch → Designs, in clear beats after the launch screen's bloom-in has
 * landed: a short hold with the slice whole, then the slice glides into the
 * header's lockup (turning from ink to the page's ink) as the yuzu fades
 * under it and the launch wordmark lifts away; once it has landed, the
 * lockup's word slides out from behind the mark; then the rest arrives: the
 * filter button and the tab bar, and the cards in a 55ms stagger.
 */
export const TO_DESIGNS = {
  /** The slice held whole before it moves. */
  hold: 150,
  /** The launch wordmark fades, 6pt up, ease-in, as the glide starts. */
  word: [150, 500],
  /** The yuzu fades under the glide, ease-in. */
  yuzu: [150, 750],
  /** The glide into the lockup, ease-out. */
  glide: [150, 750],
  /** The slice's ink turns to the page's. */
  ink: [300, 750],
  /** The lockup's word slides out from behind the mark, after the glide. */
  lockup: [750, 1100],
  /** The rest rises 16pt, each part a little after the one before. */
  rise: [1100, 1600],
  /** The cards' stagger, 55ms apart. */
  delays: [0, 55, 110, 165, 220, 275, 330],
  end: 1600 + 330,
} as const;

/** The clock when no handoff runs: every part in place. */
export const IDLE = 1_000_000;

/** The y of cubic-bezier `c` at x, by bisection on the curve's parameter. */
export function bezier(x: number, c: Curve): number {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = c;
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/**
 * How far a part is through its stretch at clock `t`, eased: 0 before, 1
 * after. The curve is passed every time: a worklet's default parameter
 * can't reach a module constant on the UI thread.
 */
export function at(t: number, span: Span, c: Curve, delay = 0): number {
  "worklet";
  const a = span[0] + delay;
  const b = span[1] + delay;
  return bezier((t - a) / (b - a), c);
}

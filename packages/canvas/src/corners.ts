import type { Artboard } from "@ponzu/core";

/*
 * A board's corners on the canvas. The canvas rounds every board a touch (a few screen px at any
 * zoom), and a design whose root has its own border-radius keeps it: each corner is the larger
 * of the two. The same radii shape everything drawn round the board: its sheet and shadow, the
 * live board's root in its shadow root, the arrival's outlines, the working ring and the frame
 * that draws a new board in. Thumbnails, screenshots and exports draw the design's own corners
 * (packages/render), which this matches whenever the design's are the larger.
 */

/** Top left, top right, bottom right, bottom left, in board px. */
export type Corners = readonly [number, number, number, number];

const SIDES = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

/** One radius in px; null for anything else (%, em, var(), an elliptical pair). */
function px(v: string): number | null {
  const t = v.trim();
  if (t === "0") return 0;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * The radii the design gives its root (inline, as the document keeps them), or null when it gives
 * one the canvas can't read as px: then the board draws the design's own corners as they are.
 */
export function designCorners(ab: Pick<Artboard, "root">): Corners | null {
  // The document keeps properties kebab-case (core's parseStyle and toKebab).
  const style = ab.root.style as Record<string, string | undefined>;
  const corners = [0, 0, 0, 0];
  const short = style["border-radius"];
  if (short !== undefined) {
    if (short.includes("/")) return null;
    const parts = short.trim().split(/\s+/).map(px);
    if (parts.length > 4 || parts.some((p) => p === null)) return null;
    const [a, b = a, c = a, d = b] = parts as number[];
    corners.splice(0, 4, a!, b!, c!, d!);
  }
  for (const [i, side] of SIDES.entries()) {
    const long = style[`border-${side}-radius`];
    if (long === undefined) continue;
    const r = px(long);
    if (r === null) return null;
    corners[i] = r;
  }
  return corners as unknown as Corners;
}

/**
 * The board's border-radius: each of the design's corners, or the canvas's own `least` (a CSS
 * length, `var(--pz-board-radius)` say) where that is larger.
 */
export function cornersCss(design: Corners, least: string): string {
  const [a, b, c, d] = design.map((r) => (r > 0 ? `max(${r}px, ${least})` : least));
  return a === b && b === c && c === d ? a! : `${a} ${b} ${c} ${d}`;
}

/**
 * A border-radius `gap` screen px outside the board's corners, in the overlay layer, where a board
 * px is `var(--z)` screen px: the working ring and the arrival frame.
 */
export function ringCorners(corners: Corners | null, least: number, gap: number): string {
  const r = (n: number) => `calc(var(--z) * ${n}px + ${gap}px)`;
  if (!corners) return `${least + gap}px`;
  const [a, b, c, d] = corners.map((n) => `max(${r(n)}, ${least + gap}px)`);
  return a === b && b === c && c === d ? a! : `${a} ${b} ${c} ${d}`;
}

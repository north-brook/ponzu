import type { Artboard } from "@ponzu/core";

/*
 * A board's corners on the canvas. The canvas rounds every board a touch (a few screen px at any
 * zoom), and a design whose root has its own border-radius keeps it: each corner is the larger
 * of the two. The same radii shape everything drawn round the board: its sheet and shadow, the
 * live board's root in its shadow root, the arrival's outlines, the working ring and the frame
 * that draws a new board in. Thumbnails, screenshots and exports draw the design's own corners
 * (packages/render), which this matches whenever the design's are the larger.
 *
 * The live board measures its root's radii as the browser resolves them (measureCorners), so a
 * token, a calc() or a % rounds the sheet, ring and frame just as it rounds the content. Until a
 * board has been live the canvas guesses from the document (ownCorners), which reads only px.
 */

/** Top left, top right, bottom right, bottom left, in board px. */
export type Corners = readonly [number, number, number, number];

/**
 * A board's corners as drawn: each corner's horizontal and vertical radius in board px (they
 * differ for an elliptical corner: a % radius on a board that isn't square, say).
 */
export interface Radii {
  x: Corners;
  y: Corners;
}

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
 * one the canvas can't read as px: the first paint's guess, before the live board measures them.
 */
export function ownCorners(ab: Pick<Artboard, "root">): Corners | null {
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

/** Round corners, as the document gives them. */
export function circular(c: Corners): Radii {
  return { x: c, y: c };
}

export function sameRadii(a: Radii, b: Radii): boolean {
  return a.x.every((v, i) => v === b.x[i]) && a.y.every((v, i) => v === b.y[i]);
}

/** A computed value split at its top-level spaces: `calc(10% + 2px) 4px` is two parts. */
export function lengths(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The radii the browser gives a board's root, in its own px: whatever the design wrote, a token
 * (`var(--radius-lg)`), a calc() or a %, resolved against the root's box. Null while the root has
 * no box to resolve against. Read it before the canvas rounds the root itself.
 */
export function measureCorners(root: HTMLElement): Radii | null {
  const style = getComputedStyle(root);
  const pairs = SIDES.map((side) => {
    const [a = "0", b = a] = lengths(style.getPropertyValue(`border-${side}-radius`));
    return [a, b] as const;
  });
  // A computed radius is px already, a token's or a calc()'s included, unless it has a % in it:
  // then it needs the root's box, which costs a layout.
  const plain = pairs.map(([a, b]) => [px(a), px(b)] as const);
  if (plain.every(([a, b]) => a !== null && b !== null))
    return {
      x: plain.map(([a]) => a!) as unknown as Corners,
      y: plain.map(([, b]) => b!) as unknown as Corners,
    };
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  if (!w || !h) return null;
  // Each corner's two lengths become a probe's width and height in a box the root's size, so the
  // browser resolves them just as it does the radius. Reset and inline, so the design's own
  // stylesheet can't size them.
  const doc = root.ownerDocument;
  const box = doc.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = `all:initial;display:block;position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:${w}px;height:${h}px`;
  const probes = pairs.map(([a, b]) => {
    const probe = doc.createElement("div");
    probe.style.cssText = "all:initial;display:block;position:absolute;left:0;top:0";
    probe.style.width = a;
    probe.style.height = b;
    box.append(probe);
    return probe;
  });
  root.after(box);
  // Screen px per layout px (the canvas's zoom), for sizes finer than offsetWidth's whole px.
  const zoom = box.getBoundingClientRect().width / w || 1;
  const x = probes.map((p) => p.getBoundingClientRect().width / zoom);
  const y = probes.map((p) => p.getBoundingClientRect().height / zoom);
  box.remove();
  return { x: x as unknown as Corners, y: y as unknown as Corners };
}

/** One side's four radii as CSS, each the design's or `least` where that is larger. */
function side(c: Corners, each: (r: number) => string): string {
  const [a, b, cc, d] = c.map(each);
  return a === b && b === cc && cc === d ? a! : `${a} ${b} ${cc} ${d}`;
}

/** Horizontal radii, and the vertical after a slash when any corner is elliptical. */
function pair(r: Radii, each: (n: number) => string): string {
  const x = side(r.x, each);
  const y = side(r.y, each);
  return x === y ? x : `${x} / ${y}`;
}

/**
 * The board's border-radius: each of the design's corners, or the canvas's own `least` (a CSS
 * length, `var(--pz-board-radius)` say) where that is larger.
 */
export function cornersCss(own: Radii, least: string): string {
  return pair(own, (r) => (r > 0 ? `max(${round(r)}px, ${least})` : least));
}

/**
 * A border-radius `gap` screen px outside the board's corners, in the overlay layer, where a board
 * px is `var(--z)` screen px: the working ring and the arrival frame.
 */
export function ringCorners(corners: Radii | null, least: number, gap: number): string {
  if (!corners) return `${least + gap}px`;
  return pair(corners, (n) => `max(calc(var(--z) * ${round(n)}px + ${gap}px), ${least + gap}px)`);
}

/** The board's largest radius, in board px: an SVG frame has one. */
export function largest(corners: Radii | null): number {
  return corners ? Math.max(...corners.x, ...corners.y) : 0;
}

/** Hundredths of a px: enough, and a measured value reads the same each time. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

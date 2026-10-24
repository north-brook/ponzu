/*
 * The phone canvas's camera, as plain math: where the page sits on screen and how big. A screen
 * point is world * zoom + (x, y), as on desktop. Kept free of the DOM so it can be tested.
 */
import type { Insets } from "./protocol.ts";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The web view's size, and what of it the app's chrome covers. */
export interface Screen {
  w: number;
  h: number;
  insets: Insets;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
/** px between the page and the screen's sides when it opens. */
export const SIDE = 16;
/** A board's title sits this far above it, on screen. */
export const LABEL = 20;
/** The widest window a page opens on as a phone does: iPhone Duo's outer display. */
export const PHONE_W = 466;
/** How wide a page's first board opens, as a share of the screen: 150 of 390 in the design. */
export const READABLE = 150 / 390;
/** How wide a board shows while it's commented on: 290 of 390 in the design. */
export const COMMENT_WIDTH = 290 / 390;
/** And how far below the chrome its top sits then, under its label. */
const COMMENT_TOP = 22;

/** An artboard's size; h is null when it isn't a px length, so the canvas measures it. As desktop's. */
export function boardSize(root: { style: Record<string, string> }) {
  const w = Number.parseFloat(root.style.width ?? "") || 1440;
  const hRaw = root.style.height;
  const h = hRaw && /^\d+(\.\d+)?px$/.test(hRaw) ? Number.parseFloat(hRaw) : null;
  return { w, h };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function toWorld(c: Camera, sx: number, sy: number) {
  return { x: (sx - c.x) / c.zoom, y: (sy - c.y) / c.zoom };
}

export function toScreen(c: Camera, wx: number, wy: number) {
  return { x: wx * c.zoom + c.x, y: wy * c.zoom + c.y };
}

/** Zoom to `zoom`, keeping the world point under (sx, sy) where it is. */
export function zoomAt(c: Camera, zoom: number, sx: number, sy: number): Camera {
  const z = clampZoom(zoom);
  const k = z / c.zoom;
  return { zoom: z, x: sx - (sx - c.x) * k, y: sy - (sy - c.y) * k };
}

/** The part of the screen the chrome leaves. */
export function safeArea(s: Screen): Box {
  const { top, right, bottom, left } = s.insets;
  return {
    x: left,
    y: top,
    w: Math.max(1, s.w - left - right),
    h: Math.max(1, s.h - top - bottom),
  };
}

/** The box around every board. */
export function bounds(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A world box centred in a screen box, as large as fits up to `maxZoom`. */
export function fitInto(rect: Box, area: Box, maxZoom = 1): Camera {
  const zoom = clampZoom(Math.min(maxZoom, area.w / rect.w, area.h / rect.h));
  return {
    zoom,
    x: area.x + (area.w - rect.w * zoom) / 2 - rect.x * zoom,
    y: area.y + (area.h - rect.h * zoom) / 2 - rect.y * zoom,
  };
}

/**
 * How a page opens: all of it when that leaves its boards readable, otherwise from its top-left
 * board at about a third of the screen wide, so a row of phone screens reads as a filmstrip to
 * pan along rather than a line of specks.
 */
export function overview(boxes: Box[], screen: Screen): Camera | null {
  const all = bounds(boxes);
  if (!all || !(all.w > 0 && all.h > 0)) return null;
  const safe = safeArea(screen);
  const area = {
    x: safe.x + SIDE,
    y: safe.y + SIDE + LABEL,
    w: Math.max(1, safe.w - SIDE * 2),
    h: Math.max(1, safe.h - SIDE * 2 - LABEL),
  };
  const fit = fitInto(all, area, 1);
  const first = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)[0]!;
  // A phone's share of the screen, however wide the window: iPhone Duo's inner display opens
  // on boards the size the outer one shows, with more of the page beside them.
  const readable = Math.min(1, (Math.min(safe.w, PHONE_W) * READABLE) / first.w);
  if (fit.zoom >= readable) return fit;
  const zoom = readable;
  const tall = all.h * zoom > area.h;
  return {
    zoom,
    x: area.x - all.x * zoom,
    y: tall ? area.y - all.y * zoom : area.y + (area.h - all.h * zoom) / 2 - all.y * zoom,
  };
}

/** A board shaped like the screen (a phone design on a phone), within 15% of its aspect. */
export function screenSized(board: Box, screen: Screen): boolean {
  const a = board.w / board.h;
  const s = screen.w / screen.h;
  return Math.abs(a - s) / s < 0.15;
}

/**
 * Focus on a board: a screen-sized one fills the screen, edge to edge, the way it would on the
 * phone; any other fits its width, from its top if it's taller than the screen.
 */
export function focusCamera(board: Box, screen: Screen): Camera {
  if (screenSized(board, screen))
    return fitInto(board, { x: 0, y: 0, w: screen.w, h: screen.h }, MAX_ZOOM);
  const zoom = clampZoom(screen.w / board.w);
  const h = board.h * zoom;
  return {
    zoom,
    x: -board.x * zoom,
    y: h <= screen.h ? (screen.h - h) / 2 - board.y * zoom : screen.insets.top - board.y * zoom,
  };
}

/**
 * Keep a focused board in view: smaller than the screen on an axis, it's centred on it; larger,
 * it can be panned to its edges and no further. A tall board stops under the chrome.
 */
export function clampToBox(c: Camera, box: Box, screen: Screen): Camera {
  const axis = (pos: number, start: number, size: number, view: number, lead = 0, trail = 0) => {
    const len = size * c.zoom;
    if (len <= view) return (view - len) / 2 - start * c.zoom;
    const max = lead - start * c.zoom;
    const min = view - trail - (start + size) * c.zoom;
    return Math.min(max, Math.max(min, pos));
  };
  return {
    zoom: c.zoom,
    x: axis(c.x, box.x, box.w, screen.w),
    y: axis(c.y, box.y, box.h, screen.h, screen.insets.top, screen.insets.bottom),
  };
}

/**
 * Where a comment's pin goes on screen. A Thread's x and y are artboard px on a board and page
 * px on the open canvas; one on a node stays within the node's box (artboard px) as it moves.
 */
export function pinPoint(
  t: { x: number; y: number },
  board: { x: number; y: number } | undefined,
  node: Box | null,
  c: Camera,
) {
  let { x, y } = t;
  if (node) {
    x = Math.min(Math.max(x, node.x), node.x + node.w);
    y = Math.min(Math.max(y, node.y), node.y + node.h);
  }
  return toScreen(c, (board?.x ?? 0) + x, (board?.y ?? 0) + y);
}

/** A screen point as a Thread's coordinates: on the board under it, or on the page. */
export function threadPoint(
  c: Camera,
  sx: number,
  sy: number,
  board?: { x: number; y: number },
): { x: number; y: number } {
  const w = toWorld(c, sx, sy);
  return board
    ? { x: Math.round(w.x - board.x), y: Math.round(w.y - board.y) }
    : { x: Math.round(w.x), y: Math.round(w.y) };
}

/** Pan just enough that a screen point is inside the safe area, `margin` px in from its edges. */
export function reveal(c: Camera, p: { x: number; y: number }, screen: Screen, margin = 48) {
  const a = safeArea(screen);
  const m = Math.min(margin, a.w / 2, a.h / 2);
  const dx = Math.max(0, a.x + m - p.x) - Math.max(0, p.x - (a.x + a.w - m));
  const dy = Math.max(0, a.y + m - p.y) - Math.max(0, p.y - (a.y + a.h - m));
  return dx || dy ? { ...c, x: c.x + dx, y: c.y + dy } : c;
}

/**
 * Bring a board up for a comment on it, as the comment and thread sheets show it: about three
 * quarters of the screen wide, centred, its top just under the chrome, unless it's already that
 * close. Then the pin (a world point) is kept above the sheet.
 */
export function commentCamera(
  board: Box,
  pin: { x: number; y: number },
  c: Camera,
  s: Screen,
  sheet: number,
) {
  const above: Screen = { ...s, insets: { ...s.insets, bottom: Math.max(s.insets.bottom, sheet) } };
  // The canvas's own part of the screen: clear of a rail at the side or a half past the fold.
  const area = safeArea(s);
  // Short of room above the sheet (iPhone Duo's outer display, and folded halves), the board
  // fits the room there rather than three quarters of the width.
  const room = Math.max(1, s.h - above.insets.bottom - s.insets.top - COMMENT_TOP - 16);
  const target = clampZoom(
    Math.min(1, (COMMENT_WIDTH * area.w) / board.w, Math.max(room, area.h * 0.35) / board.h),
  );
  let next = c;
  if (c.zoom < target * 0.98 || c.zoom > target * 1.5) {
    next = {
      zoom: target,
      x: area.x + (area.w - board.w * target) / 2 - board.x * target,
      y: s.insets.top + COMMENT_TOP - board.y * target,
    };
  }
  return reveal(next, toScreen(next, pin.x, pin.y), above);
}

/** Boards in reading order, top row first: the order a focused board swipes through. */
export function readingOrder<T extends Box>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => {
    // Boards whose tops are within half the shorter one's height share a row.
    const row = Math.min(a.h, b.h) / 2;
    return Math.abs(a.y - b.y) < row ? a.x - b.x : a.y - b.y;
  });
}

/**
 * A step of a camera move from `a` to `b`: the zoom changes evenly in ratio and the screen's
 * centre travels in a straight line over the page, so a focus reads as one motion.
 */
export function between(a: Camera, b: Camera, t: number, screen: Screen): Camera {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const cx = screen.w / 2;
  const cy = screen.h / 2;
  const ca = toWorld(a, cx, cy);
  const cb = toWorld(b, cx, cy);
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
  const wx = ca.x + (cb.x - ca.x) * t;
  const wy = ca.y + (cb.y - ca.y) * t;
  return { zoom, x: cx - wx * zoom, y: cy - wy * zoom };
}

/**
 * Where standby's camera rests on a board an agent touches: the whole board in view, with a
 * margin of a tenth of the screen around it, up to 1:1.
 */
export function followCamera(board: Box, screen: Screen): Camera {
  const m = Math.min(screen.w, screen.h) * 0.1;
  return fitInto(board, { x: m, y: m, w: screen.w - 2 * m, h: screen.h - 2 * m }, 1);
}

/** cubic-bezier(0.45, 0, 0.2, 1): standby's slow ease, in and out, as the Duo board draws it. */
export function easeFollow(t: number): number {
  return bezier(0.45, 0, 0.2, 1, t);
}

/** cubic-bezier(0.2, 0.8, 0.2, 1), the brand's ease-out (`--ease-out`). */
export function easeOut(t: number): number {
  return bezier(0.2, 0.8, 0.2, 1, t);
}

function bezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  // Newton's method for the curve's parameter at x = t; the curve is monotonic in x.
  let s = t;
  for (let i = 0; i < 8; i++) {
    const x = ((ax * s + bx) * s + cx) * s - t;
    const d = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(x) < 1e-6 || !d) break;
    s -= x / d;
  }
  return ((ay * s + by) * s + cy) * s;
}

/** A released pan keeps going and slows like a scroll view: this much of its speed per ms. */
export const DECELERATION = 0.998;
/** px/ms below which a glide stops. */
export const REST = 0.02;

/** How far a glide goes in `dt` ms at velocity `v` (px/ms), and its speed after. */
export function glide(v: { x: number; y: number }, dt: number) {
  const k = DECELERATION ** dt;
  // The integral of v·k^t over dt.
  const travel = (1 - k) / -Math.log(DECELERATION);
  return { dx: v.x * travel, dy: v.y * travel, v: { x: v.x * k, y: v.y * k } };
}

/**
 * Whether a board's title, above it on screen, would lie over another board: zoomed out, or with
 * boards close together, it would read as that one's. Then it's hidden. As on desktop.
 */
export function labelCovers(
  ab: Box & { id: string },
  others: (Box & { id: string })[],
  zoom: number,
) {
  const top = ab.y - LABEL / zoom;
  return others.some(
    (o) => o.id !== ab.id && o.x < ab.x + ab.w && o.x + o.w > ab.x && o.y < ab.y && o.y + o.h > top,
  );
}

/*
 * What a comment's picture shows: the area of the page round its pin. Centred on the pin, at a
 * scale where what it points at is recognisable (the node it is pinned to with room round it, a
 * stretch of the board, or the boards either side of a pin on the open canvas), then moved only
 * as far as keeps it from running off the boards into empty canvas, never so far the pin leaves
 * it. Pure, in page px, so the rules are tested on their own.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The narrowest and widest stretch of page a picture shows, in page px. */
export const AREA_WIDTH = { min: 360, max: 2400 } as const;
/** The stretch of a board a pin on it, on no node of its own, shows. */
const BOARD_WIDTH = { min: 480, max: 960 } as const;
/** On the open canvas: the least, and the room past the nearest board's edge. */
const OPEN_WIDTH = 720;
const OPEN_REACH = 280;
/** A node pinned to fills this share of the picture's width or height, whichever it meets first. */
const NODE_SHARE = 0.55;
/**
 * How close to the picture's edge the pin may be moved, as a share of its size: its own
 * radius and a little more, at the size the picture is shown.
 */
const PIN_MARGIN = 0.07;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The distance from a point to a rect: 0 inside it. */
export function distanceTo(p: { x: number; y: number }, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a picture starts on one axis: centred on the pin, then within `content` where it fits
 * (centred on it where it doesn't), and never with the pin closer than the margin to an edge.
 */
function place(pin: number, size: number, content: { at: number; size: number } | null) {
  let at = pin - size / 2;
  if (content) {
    at =
      size <= content.size
        ? clamp(at, content.at, content.at + content.size - size)
        : content.at + content.size / 2 - size / 2;
  }
  const margin = size * PIN_MARGIN;
  return clamp(at, pin - size + margin, pin - margin);
}

/**
 * The area of the page a comment's picture shows, at `aspect` (width over height).
 *
 * - `boards`: the page's boards, as laid out.
 * - `board`: the one the pin is on, if any.
 * - `node`: the node it is pinned to, in page px, when it is smaller than its board.
 */
export function pictureArea({
  pin,
  boards,
  board,
  node,
  aspect,
}: {
  pin: { x: number; y: number };
  boards: Rect[];
  board: Rect | null;
  node: Rect | null;
  aspect: number;
}): Rect {
  let w: number;
  if (node && board && (node.w < board.w * 0.9 || node.h < board.h * 0.9)) {
    // The node with room round it.
    w = Math.max(node.w, node.h * aspect) / NODE_SHARE;
  } else if (board) {
    w = clamp(board.w / 2, BOARD_WIDTH.min, BOARD_WIDTH.max);
  } else {
    // Far enough out to reach the nearest board, and a stretch of it.
    const near = Math.min(...boards.map((b) => distanceTo(pin, b)));
    w = Number.isFinite(near) ? Math.max(OPEN_WIDTH, 2 * (near + OPEN_REACH)) : OPEN_WIDTH;
  }
  w = clamp(w, AREA_WIDTH.min, AREA_WIDTH.max);
  const h = w / aspect;

  // What the picture keeps to: the pin's board, or on the open canvas the boards near it.
  const around = { x: pin.x - w, y: pin.y - h, w: 2 * w, h: 2 * h };
  const content = board ?? union(boards.filter((b) => overlaps(b, around)));
  return {
    x: place(pin.x, w, content && { at: content.x, size: content.w }),
    y: place(pin.y, h, content && { at: content.y, size: content.h }),
    w,
    h,
  };
}

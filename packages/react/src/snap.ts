/**
 * Where a dragged set of artboards settles: its edges and centres catch the
 * edges and centres of the boards around it, and it catches the spacing its
 * row or column already uses. Pure, in page px, so the canvas only draws what
 * this returns.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line two or more boxes share: vertical at `x = at` for axis "x", horizontal for "y". */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/** A space between two boxes along an axis, from `a` to `b`, drawn at `at` across it. */
export interface Gap {
  axis: "x" | "y";
  a: number;
  b: number;
  at: number;
}

export interface Snapped {
  dx: number;
  dy: number;
  guides: Guide[];
  gaps: Gap[];
}

type Axis = "x" | "y";

/** A box's span along an axis, and across it. */
const lo = (b: Box, axis: Axis) => (axis === "x" ? b.x : b.y);
const len = (b: Box, axis: Axis) => (axis === "x" ? b.w : b.h);
const hi = (b: Box, axis: Axis) => lo(b, axis) + len(b, axis);
const cross = (axis: Axis): Axis => (axis === "x" ? "y" : "x");
const anchors = (b: Box, axis: Axis) => [lo(b, axis), lo(b, axis) + len(b, axis) / 2, hi(b, axis)];

/** Whether two boxes share some of their span across `axis`: they sit in one row (or column). */
const inLine = (a: Box, b: Box, axis: Axis) => {
  const c = cross(axis);
  return lo(a, c) < hi(b, c) && lo(b, c) < hi(a, c);
};

const shift = (b: Box, axis: Axis, d: number): Box =>
  axis === "x" ? { ...b, x: b.x + d } : { ...b, y: b.y + d };

/** The space between two boxes in a row, drawn through the middle of the span they share. */
function gapBetween(a: Box, b: Box, axis: Axis): Gap {
  const c = cross(axis);
  const top = Math.max(lo(a, c), lo(b, c));
  const bottom = Math.min(hi(a, c), hi(b, c));
  return { axis, a: hi(a, axis), b: lo(b, axis), at: (top + bottom) / 2 };
}

interface Candidate {
  /** How far to move along the axis to land on it. */
  d: number;
  /** The spaces it lands on, given where the box ends up. */
  gaps?: (box: Box) => Gap[];
}

/** Every place along one axis the box could catch, near or far. */
function candidates(box: Box, others: Box[], axis: Axis): Candidate[] {
  const out: Candidate[] = [];
  const mine = anchors(box, axis);
  for (const o of others)
    for (const t of anchors(o, axis)) for (const m of mine) out.push({ d: t - m });

  // Spacing: only boxes in the box's row count, sorted along it.
  const row = others.filter((o) => inLine(o, box, axis)).sort((a, b) => lo(a, axis) - lo(b, axis));
  if (!row.length) return out;
  const spaced: { a: Box; b: Box; size: number }[] = [];
  for (let i = 0; i < row.length; i++)
    for (let j = i + 1; j < row.length; j++) {
      const a = row[i]!;
      const b = row[j]!;
      const size = lo(b, axis) - hi(a, axis);
      // Only neighbours: nothing in the row between them.
      if (size <= 0 || !inLine(a, b, axis)) continue;
      if (
        row.some(
          (m) => m !== a && m !== b && lo(m, axis) >= hi(a, axis) && hi(m, axis) <= lo(b, axis),
        )
      )
        continue;
      spaced.push({ a, b, size });
    }

  // The nearest neighbour on each side of where the box's centre is.
  const mid = lo(box, axis) + len(box, axis) / 2;
  let before: Box | undefined;
  let after: Box | undefined;
  for (const o of row) {
    if (hi(o, axis) <= mid && (!before || hi(o, axis) > hi(before, axis))) before = o;
    if (lo(o, axis) >= mid && (!after || lo(o, axis) < lo(after, axis))) after = o;
  }
  // Every pair already spaced this far apart, to show the box matches them.
  const same = (size: number) =>
    spaced.filter((s) => Math.abs(s.size - size) < 0.5).map((s) => gapBetween(s.a, s.b, axis));

  for (const s of spaced) {
    if (before)
      out.push({
        d: hi(before, axis) + s.size - lo(box, axis),
        gaps: (moved) => [...same(s.size), gapBetween(before!, moved, axis)],
      });
    if (after)
      out.push({
        d: lo(after, axis) - s.size - hi(box, axis),
        gaps: (moved) => [...same(s.size), gapBetween(moved, after!, axis)],
      });
  }
  // Centred between its neighbours: the same space on both sides.
  if (before && after) {
    const room = lo(after, axis) - hi(before, axis) - len(box, axis);
    if (room > 0)
      out.push({
        d: hi(before, axis) + room / 2 - lo(box, axis),
        gaps: (moved) => [gapBetween(before!, moved, axis), gapBetween(moved, after!, axis)],
      });
  }
  return out;
}

/** The closest catch along one axis within `threshold`, if any. */
function nearest(box: Box, others: Box[], axis: Axis, threshold: number) {
  let best: Candidate | undefined;
  for (const c of candidates(box, others, axis))
    if (Math.abs(c.d) <= threshold && (!best || Math.abs(c.d) < Math.abs(best.d))) best = c;
  return best;
}

/** Lines the box shares with the others along an axis, each merged across every box on it. */
function guidesFor(box: Box, others: Box[], axis: Axis): Guide[] {
  const c = cross(axis);
  const lines = new Map<number, Guide>();
  for (const at of anchors(box, axis))
    for (const o of others)
      if (anchors(o, axis).some((t) => Math.abs(t - at) < 0.5)) {
        const g = lines.get(at) ?? { axis, at, from: lo(box, c), to: hi(box, c) };
        g.from = Math.min(g.from, lo(o, c));
        g.to = Math.max(g.to, hi(o, c));
        lines.set(at, g);
      }
  // A centre line between two edge lines says nothing they don't: boards that share both edges
  // share their centre too.
  const [start, mid, end] = anchors(box, axis);
  if (lines.has(mid!) && (lines.has(start!) || lines.has(end!))) lines.delete(mid!);
  return [...lines.values()];
}

/**
 * Moves `box` by (dx, dy), then lets it catch the others within `threshold`
 * page px on each axis. `lock` holds an axis where it started: shift-dragging
 * along a line doesn't snap off it.
 */
export function snapMove(
  box: Box,
  others: Box[],
  dx: number,
  dy: number,
  threshold: number,
  lock?: Axis,
): Snapped {
  let moved = { ...box, x: box.x + dx, y: box.y + dy };
  const caught: Partial<Record<Axis, Candidate>> = {};
  for (const axis of ["x", "y"] as const) {
    if (lock === axis) continue;
    const c = nearest(moved, others, axis, threshold);
    if (!c) continue;
    caught[axis] = c;
    moved = shift(moved, axis, c.d);
  }
  const guides: Guide[] = [];
  const gaps: Gap[] = [];
  for (const axis of ["x", "y"] as const) {
    const c = caught[axis];
    if (!c) continue;
    if (c.gaps) gaps.push(...c.gaps(moved));
    else guides.push(...guidesFor(moved, others, axis));
  }
  return { dx: moved.x - box.x, dy: moved.y - box.y, guides, gaps };
}

/** The box around several. */
export function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x1 - x, h: y1 - y };
}

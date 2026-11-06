/*
 * Dragging a tab along a row of tabs, as the page bar does. Pure: the spans are
 * the tabs' places as the drag found them, in screen px, in list order.
 */

export interface Span {
  left: number;
  width: number;
}

/** How far the tab from `from` can go: its row's ends. */
export function clampShift(spans: readonly Span[], from: number, dx: number): number {
  const first = spans[0]!;
  const last = spans.at(-1)!;
  const s = spans[from]!;
  const min = first.left - s.left;
  const max = last.left + last.width - (s.left + s.width);
  return Math.min(max, Math.max(min, dx));
}

/**
 * Where the tab from `from`, moved `dx`, lands: its index in the list once it
 * has moved. It passes a neighbour once its leading edge crosses that one's
 * middle, so a wide tab reaches the ends as readily as a narrow one.
 */
export function dropIndex(spans: readonly Span[], from: number, dx: number): number {
  const s = spans[from]!;
  const left = s.left + dx;
  const right = left + s.width;
  let to = from;
  spans.forEach((o, i) => {
    const mid = o.left + o.width / 2;
    if (i < from && left < mid) to--;
    if (i > from && right > mid) to++;
  });
  return to;
}

/** How far tab `i` slides aside to make room while the tab from `from` hovers over `to`. */
export function makeRoom(spans: readonly Span[], from: number, to: number, i: number): number {
  if (i === from) return 0;
  const step = stride(spans, from);
  if (i < from && i >= to) return step;
  if (i > from && i <= to) return -step;
  return 0;
}

/** Where the tab from `from` comes to rest at `to`, as a shift from its own place. */
export function restAt(spans: readonly Span[], from: number, to: number): number {
  const s = spans[from]!;
  const t = spans[to]!;
  if (to === from) return 0;
  // Moving right, it ends where `to` ended; moving left, it starts where `to` started.
  return to > from ? t.left + t.width - (s.left + s.width) : t.left - s.left;
}

/** The room the tab from `from` takes in the row: its width and the gap after it. */
function stride(spans: readonly Span[], from: number): number {
  const s = spans[from]!;
  const next = spans[from + 1];
  if (next) return next.left - s.left;
  const prev = spans[from - 1];
  return prev ? s.left - (prev.left + prev.width) + s.width : s.width;
}

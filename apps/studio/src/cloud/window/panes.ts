/*
 * How wide the window's side panes may be, in pixels. Each starts at the design's width (the
 * spec's frame: sidebar 300, thread rail 360); the person can drag its edge between a minimum
 * that keeps its content whole and a maximum that leaves the canvas room to work in, and
 * double-clicking the edge brings it back to the design's.
 *
 * - sidebar: 240 still shows a row's preview, its name and its project on one line each, and
 *   the header's switcher beside its three icons; past 420 the rows only get emptier.
 * - rail: 300 is a message bubble's widest (280) and the rail's padding; past 520 lines of the
 *   thread get too long to read.
 * - the canvas keeps at least 400, also when the window is made small: at the smallest window
 *   (1100) both panes at the design's widths leave it 422.
 */

export type Pane = "sidebar" | "rail";

export interface PaneLimits {
  /** The design's width, and where a double-click on the edge returns it. */
  default: number;
  min: number;
  max: number;
}

export const PANES: Record<Pane, PaneLimits> = {
  sidebar: { default: 300, min: 240, max: 420 },
  rail: { default: 360, min: 300, max: 520 },
};

export const CANVAS_MIN = 400;

/** Arrow keys on a pane's edge move it this far; with Shift, `PANE_STEP_LARGE`. */
export const PANE_STEP = 10;
export const PANE_STEP_LARGE = 50;

/** A width within the pane's limits, in whole pixels; anything that isn't one is the default. */
export function paneWidth(pane: Pane, width: unknown): number {
  const { default: fallback, min, max } = PANES[pane];
  if (typeof width !== "number" || !Number.isFinite(width)) return fallback;
  return Math.min(max, Math.max(min, Math.round(width)));
}

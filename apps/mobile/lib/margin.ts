import { Store, useStore } from "./store";

/**
 * The screen's horizontal layout margin: where the system's header puts its
 * items (the lockup and titles on the left, the filter's glass on the right).
 * Everything on a tab's page sits on it too, so the header and the page share
 * one edge. Read from the header itself, since it differs by device: the
 * bar places a custom left item `BAR_ITEM_INSET` inside its margin, so the
 * margin is where that item is less the inset (`measureMargin`). 16 until
 * it's been read, which is the iPhone's.
 */
export const margin = new Store<number>(16);

export function useMargin(): number {
  return useStore(margin);
}

/**
 * How far inside the margin the bar puts a custom left item's view: its glass
 * would start at the margin, the view 4pt in. Measured on the simulator: the
 * view at 20, the filter's glass ending 16 from the right edge.
 */
export const BAR_ITEM_INSET = 4;

/** The header's left item is at `x` in the window: the margin is the inset short of it. */
export function measureMargin(x: number) {
  const m = Math.round((x - BAR_ITEM_INSET) * 3) / 3;
  if (m > 0 && m < 40 && Math.abs(m - margin.get()) > 0.1) margin.set(m);
}

/**
 * The lockup's slice ink starts 1.33pt inside its 28pt box: drawn the bar's
 * inset and that much to the left, the ink, not the box, sits on the margin
 * (measured: ink at 16.00 with a 16pt margin, at both sizes).
 */
export const LOCKUP_INK = BAR_ITEM_INSET + 1.33;

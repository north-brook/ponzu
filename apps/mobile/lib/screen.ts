/**
 * The iPhone's display corners, so what floats near them can follow them:
 * a sheet held `inset` in from the edges rounds by the display's radius less
 * that inset, concentric with the glass, as iOS 26's own sheets and bars do.
 *
 * iOS has no public API for the radius (UIScreen's `_displayCornerRadius` is
 * private), so it's looked up by the screen's size in points, portrait.
 * Measured from the devices' display masks; an unknown size gets the
 * current Pro's.
 */
const RADII: Record<string, number> = {
  // iPhone 17 Pro, 17, Air-class 6.3"
  "402x874": 55,
  // iPhone 17 Pro Max
  "440x956": 55,
  // iPhone Air
  "420x912": 55,
  // iPhone 15/16 Pro, 15/16
  "393x852": 55,
  // iPhone 15/16 Pro Max, Plus
  "430x932": 55,
  // iPhone 16e, 17e, 14, 13
  "390x844": 47.33,
  // iPhone 14 Plus, 13 Pro Max
  "428x926": 53.33,
  // iPhone 13 mini
  "375x812": 44,
};

const DEFAULT = 55;

/** The display's corner radius, in points. */
export function displayRadius(width: number, height: number): number {
  const w = Math.round(Math.min(width, height));
  const h = Math.round(Math.max(width, height));
  return RADII[`${w}x${h}`] ?? DEFAULT;
}

/** A corner held `inset` in from the display's edges, concentric with it. */
export function concentric(width: number, height: number, inset: number): number {
  return Math.max(0, displayRadius(width, height) - inset);
}

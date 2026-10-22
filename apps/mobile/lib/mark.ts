/**
 * The slice, as `packages/react/src/slice.ts` draws it: six 60° segments on
 * a 64-unit grid, clockwise from the top right, each stroked 3.4 in its own
 * color. React Native code can't import `@ponzu/react`, so the paths are
 * copied here; `mark.test.ts` keeps the two equal.
 */
export const SLICE = [
  "M36 25.07L36 4.99A27.3 27.3 0 0 1 53.39 15.03Z",
  "M40 32L57.39 21.96A27.3 27.3 0 0 1 57.39 42.04Z",
  "M36 38.93L53.39 48.97A27.3 27.3 0 0 1 36 59.01Z",
  "M28 38.93L28 59.01A27.3 27.3 0 0 1 10.61 48.97Z",
  "M24 32L6.61 42.04A27.3 27.3 0 0 1 6.61 21.96Z",
  "M28 25.07L10.61 15.03A27.3 27.3 0 0 1 28 4.99Z",
] as const;
export const SLICE_STROKE = 3.4;

/**
 * The launch screen's layout, from the design's 1 Launch artboard: the slice
 * and the wordmark in a column centred between a 54pt status bar and 60pt
 * of room below. That puts the slice's centre LAUNCH_LIFT above the middle
 * of any screen, (mark + gap + word) / 2 - mark / 2 + (bottom - top) / 2.
 * The splash image (scripts/make-images.swift) carries the same offset, so
 * the native splash hands off to the first frame without a jump.
 */
export const LAUNCH = { mark: 112, gap: 22, word: 44, top: 54, bottom: 60 } as const;
export const LAUNCH_LIFT =
  (LAUNCH.mark + LAUNCH.gap + LAUNCH.word) / 2 - LAUNCH.mark / 2 + (LAUNCH.bottom - LAUNCH.top) / 2;

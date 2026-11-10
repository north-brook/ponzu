/**
 * The slice's six segments on a 64-unit grid, clockwise from the top right.
 * Each is a 60° sector inset from its neighbours; drawn with a 3.4 round
 * stroke in its own color (`SLICE_STROKE`), which softens the corners and
 * brings the gaps to 4.6.
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

import { expect, test } from "bun:test";
import { fitPanes, PANES } from "./panes.ts";

test("panes that fit keep the widths they were left at", () => {
  expect(fitPanes(800, { sidebar: 420, rail: 360 })).toEqual({ sidebar: 420, rail: 360 });
  expect(fitPanes(300, { rail: 300 })).toEqual({ rail: 300 });
});

test("a shortfall is shared in proportion to each pane's room above its minimum", () => {
  // 940 wanted in 700: 240 short, of the 180 + 220 above the minimums.
  const fitted = fitPanes(700, { sidebar: 420, rail: 520 });
  expect(fitted.sidebar).toBeCloseTo(420 - (240 * 180) / 400, 6);
  expect(fitted.rail).toBeCloseTo(520 - (240 * 220) / 400, 6);
  expect((fitted.sidebar ?? 0) + (fitted.rail ?? 0)).toBeCloseTo(700, 6);
  // A pane at its minimum gives nothing up.
  expect(fitPanes(600, { sidebar: 240, rail: 400 })).toEqual({ sidebar: 240, rail: 360 });
});

test("no pane goes below its minimum, however small the room", () => {
  expect(fitPanes(100, { sidebar: 300, rail: 360 })).toEqual({
    sidebar: PANES.sidebar.min,
    rail: PANES.rail.min,
  });
});

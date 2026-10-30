import { expect, test } from "bun:test";
import {
  CREASE,
  commentsButton,
  designColumns,
  duoLayout,
  foldAt,
  halves,
  hasRail,
  SHEET_MAX,
  sheetMax,
} from "./duo-layout";

// iPhone Duo's windows, in points, and iPhones'.
const outer = { width: 466, height: 678 };
const innerUpright = { width: 669, height: 951 };
const innerSideways = { width: 951, height: 669 };
const iphone = { width: 402, height: 874 };
const small = { width: 390, height: 844 };

test("an iPhone keeps the canvas's own bars and the sheet", () => {
  expect(duoLayout(iphone, false, false)).toEqual({ bars: "phone", split: null, panel: false });
  expect(duoLayout(small, false, false)).toEqual({ bars: "phone", split: null, panel: false });
});

test("closed, the outer display's bars are the system's rail; comments are the sheet", () => {
  expect(duoLayout(outer, true, false)).toEqual({ bars: "rail", split: null, panel: false });
});

test("the outer display without its rail (an older SDK) reads as a phone", () => {
  expect(duoLayout(outer, false, false).bars).toBe("phone");
});

test("open flat and sideways, the design has the display, comments an inset panel", () => {
  expect(duoLayout(innerSideways, true, false)).toEqual({ bars: "rail", split: null, panel: true });
});

test("open flat and upright, horizontal bars and the sheet", () => {
  expect(duoLayout(innerUpright, false, false)).toEqual({
    bars: "upright",
    split: null,
    panel: false,
  });
});

test("partly open upright (a laptop): the design above the fold, comments below", () => {
  expect(duoLayout(innerUpright, false, true)).toEqual({
    bars: "upright",
    split: "below",
    panel: false,
  });
});

test("partly open sideways (a book): the design on the left, comments on the right", () => {
  expect(duoLayout(innerSideways, true, true)).toEqual({
    bars: "rail",
    split: "beside",
    panel: false,
  });
});

test("a hinge partly open on the outer display (a tent) changes nothing there", () => {
  expect(duoLayout(outer, true, true)).toEqual({ bars: "rail", split: null, panel: false });
});

test("the fold falls in the middle of the axis it divides, 24pt reserved", () => {
  expect(foldAt(innerUpright, "below")).toBe(951 / 2);
  expect(foldAt(innerSideways, "beside")).toBe(951 / 2);
  expect(CREASE * 2).toBe(24);
});

test("like a book, the halves meet at the fold: the canvas frames short of the crease", () => {
  const { canvas, comments } = halves(innerSideways, "beside");
  const fold = innerSideways.width / 2;
  expect(canvas).toEqual({ left: 0, top: 0, width: fold - CREASE, height: innerSideways.height });
  // Full bleed from the fold itself to the window's edge, under the rail: no band between.
  expect(comments).toEqual({
    left: fold,
    top: 0,
    width: innerSideways.width - fold,
    height: innerSideways.height,
  });
  expect(comments.left + comments.width).toBe(innerSideways.width);
});

test("like a laptop, the comments half runs from the fold to the foot", () => {
  const { canvas, comments } = halves(innerUpright, "below");
  const fold = innerUpright.height / 2;
  expect(canvas).toEqual({ left: 0, top: 0, width: innerUpright.width, height: fold - CREASE });
  expect(comments).toEqual({
    left: 0,
    top: fold,
    width: innerUpright.width,
    height: innerUpright.height - fold,
  });
});

test("comments' button joins Back on the rail, stays bottom right upright, and goes folded", () => {
  expect(commentsButton(duoLayout(outer, true, false))).toBe("rail");
  expect(commentsButton(duoLayout(innerSideways, true, false))).toBe("rail");
  expect(commentsButton(duoLayout(innerUpright, false, false))).toBe("toolbar");
  expect(commentsButton(duoLayout(innerSideways, true, true))).toBeNull();
  expect(commentsButton(duoLayout(innerUpright, false, true))).toBeNull();
  // A phone's bars are the canvas's own, not the system's.
  expect(commentsButton(duoLayout(iphone, false, false))).toBeNull();
});

test("the comment sheet is centred and bounded only with the inner display sideways", () => {
  expect(sheetMax(duoLayout(innerSideways, true, false))).toBe(SHEET_MAX);
  expect(sheetMax(duoLayout(innerSideways, true, true))).toBe(SHEET_MAX);
  // Narrower than the canvas beside the rail, wider than any iPhone's sheet.
  expect(SHEET_MAX).toBeLessThan(innerSideways.width - 84);
  expect(SHEET_MAX).toBeGreaterThan(iphone.width);
  for (const layout of [
    duoLayout(iphone, false, false),
    duoLayout(small, false, false),
    duoLayout(outer, true, false),
    duoLayout(innerUpright, false, false),
    duoLayout(innerUpright, false, true),
  ]) {
    expect(sheetMax(layout)).toBeUndefined();
  }
});

test("Designs: two columns on a phone and closed, three inside", () => {
  expect(designColumns(iphone.width)).toBe(2);
  expect(designColumns(outer.width - 84)).toBe(2);
  expect(designColumns(innerUpright.width)).toBe(3);
  expect(designColumns(innerSideways.width - 84)).toBe(3);
});

test("the rail is the side inset the system gives its bars (84pt), not a notch", () => {
  expect(hasRail({ left: 0, right: 84 })).toBe(true);
  expect(hasRail({ left: 0, right: 0 })).toBe(false);
  expect(hasRail({ left: 47, right: 47 })).toBe(false);
});

import { expect, test } from "bun:test";
import { CREASE, designColumns, duoLayout, foldAt, hasRail } from "./duo-layout";

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

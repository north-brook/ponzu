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
// iPads, full screen: 13-inch, 11-inch and mini, each way up.
const pad13 = { width: 1032, height: 1376 };
const pad13Sideways = { width: 1376, height: 1032 };
const pad11 = { width: 834, height: 1194 };
const pad11Sideways = { width: 1194, height: 834 };
const mini = { width: 744, height: 1133 };

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

test("an iPad keeps the system's bars across the top, sideways too, with no rail", () => {
  expect(duoLayout(pad13Sideways, false, false)).toEqual({
    bars: "upright",
    split: null,
    panel: true,
  });
  expect(duoLayout(pad11Sideways, false, false)).toEqual({
    bars: "upright",
    split: null,
    panel: true,
  });
});

test("an iPad upright has the panel once there's room for it beside the canvas", () => {
  expect(duoLayout(pad13, false, false)).toEqual({ bars: "upright", split: null, panel: true });
  expect(duoLayout(pad11, false, false)).toEqual({ bars: "upright", split: null, panel: false });
  expect(duoLayout(mini, false, false)).toEqual({ bars: "upright", split: null, panel: false });
});

test("an iPad window as narrow as a phone's (Stage Manager, Split View) is laid out as one", () => {
  expect(duoLayout({ width: 375, height: 1032 }, false, false)).toEqual({
    bars: "phone",
    split: null,
    panel: false,
  });
  expect(duoLayout({ width: 507, height: 834 }, false, false).bars).toBe("phone");
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

test("the comment sheet is centred and bounded with the inner display sideways", () => {
  expect(sheetMax(duoLayout(innerSideways, true, false), innerSideways.width)).toBe(SHEET_MAX);
  expect(sheetMax(duoLayout(innerSideways, true, true), innerSideways.width)).toBe(SHEET_MAX);
  // Narrower than the canvas beside the rail, wider than any iPhone's sheet.
  expect(SHEET_MAX).toBeLessThan(innerSideways.width - 84);
  expect(SHEET_MAX).toBeGreaterThan(iphone.width);
  for (const w of [iphone, small, outer, innerUpright]) {
    const rail = w === outer;
    expect(sheetMax(duoLayout(w, rail, false), w.width)).toBeUndefined();
  }
  expect(sheetMax(duoLayout(innerUpright, false, true), innerUpright.width)).toBeUndefined();
});

test("Designs: two columns on a phone and closed, three inside", () => {
  expect(designColumns(iphone.width)).toBe(2);
  expect(designColumns(outer.width - 84)).toBe(2);
  expect(designColumns(innerUpright.width)).toBe(3);
  expect(designColumns(innerSideways.width - 84)).toBe(3);
});

test("Designs: more columns as an iPad's window widens, each card 230pt or more", () => {
  expect(designColumns(mini.width)).toBe(3);
  expect(designColumns(pad11.width)).toBe(3);
  expect(designColumns(pad13.width)).toBe(4);
  expect(designColumns(pad11Sideways.width)).toBe(4);
  expect(designColumns(pad13Sideways.width)).toBe(5);
});

test("the rail is the side inset the system gives its bars (84pt), not a notch", () => {
  expect(hasRail({ left: 0, right: 84 })).toBe(true);
  expect(hasRail({ left: 0, right: 0 })).toBe(false);
  expect(hasRail({ left: 47, right: 47 })).toBe(false);
});

test("an iPad's comment sheet floats centred, upright and sideways", () => {
  for (const w of [mini, pad11, pad13, pad11Sideways, pad13Sideways]) {
    expect(sheetMax(duoLayout(w, false, false), w.width)).toBe(SHEET_MAX);
  }
  // A Stage Manager window as narrow as a phone's keeps a phone's sheet.
  expect(sheetMax(duoLayout({ width: 375, height: 1032 }, false, false), 375)).toBeUndefined();
});

test("an iPad's comments button is bottom right, under bars across the top", () => {
  expect(commentsButton(duoLayout(pad13Sideways, false, false))).toBe("toolbar");
  expect(commentsButton(duoLayout(pad11, false, false))).toBe("toolbar");
});

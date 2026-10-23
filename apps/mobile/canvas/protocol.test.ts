import { expect, test } from "bun:test";
import { parseFromCanvas } from "./protocol.ts";

test("the canvas's messages the app feels arrive whole: a pin dropped, focus in and out, a gesture", () => {
  const longpress = { t: "longpress", pageId: "pg", artboardId: "ab", x: 10, y: 20 };
  expect(parseFromCanvas(JSON.stringify(longpress))).toEqual(longpress);
  expect(parseFromCanvas(JSON.stringify({ t: "focused", artboardId: "ab" }))).toEqual({
    t: "focused",
    artboardId: "ab",
  });
  expect(parseFromCanvas(JSON.stringify({ t: "focused", artboardId: null }))).toEqual({
    t: "focused",
    artboardId: null,
  });
  expect(parseFromCanvas(JSON.stringify({ t: "gesture" }))).toEqual({ t: "gesture" });
});

test("anything else isn't ours", () => {
  expect(parseFromCanvas("not json")).toBeNull();
  expect(parseFromCanvas("42")).toBeNull();
  expect(parseFromCanvas(JSON.stringify({ kind: "focused" }))).toBeNull();
});

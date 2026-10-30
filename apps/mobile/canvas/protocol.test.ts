import { expect, test } from "bun:test";
import { parseFromCanvas, toCanvasScript } from "./protocol.ts";

test("the canvas's messages the app feels arrive whole: a pin dropped, focus in and out, a gesture", () => {
  const longpress = { t: "longpress", pageId: "pg", artboardId: "ab", x: 10, y: 20 } as const;
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
  expect(parseFromCanvas(JSON.stringify({ t: "drawn" }))).toEqual({ t: "drawn" });
});

test("a measured gesture arrives whole, and the ask for it goes in as a script", () => {
  const perf = {
    t: "perf",
    gesture: {
      kind: "pan",
      ms: 640,
      fps: 52.1,
      p95: 33.3,
      max: 50,
      jank: 4,
      moves: 30,
      movesPerS: 46.2,
      maxGapMs: 50,
      boards: 12,
    },
  } as const;
  expect(parseFromCanvas(JSON.stringify(perf))).toEqual(perf);
  expect(toCanvasScript({ t: "probe", rate: 0.05 })).toBe(
    'window.__ponzuCanvas&&window.__ponzuCanvas.receive({"t":"probe","rate":0.05});true;',
  );
});

test("an unsent comment's pin held, and where it landed once moved, arrive whole", () => {
  const hold = { t: "holdUnsent", key: "studio\0/k.design\0pin:ab:4:8" } as const;
  expect(parseFromCanvas(JSON.stringify(hold))).toEqual(hold);
  const moved = {
    t: "moved",
    key: hold.key,
    pageId: "pg",
    artboardId: "ab_2",
    nodeId: "n_lid",
    x: 30,
    y: 12,
  } as const;
  expect(parseFromCanvas(JSON.stringify(moved))).toEqual(moved);
  expect(toCanvasScript({ t: "place" })).toBe(
    'window.__ponzuCanvas&&window.__ponzuCanvas.receive({"t":"place"});true;',
  );
});

test("anything else isn't ours", () => {
  expect(parseFromCanvas("not json")).toBeNull();
  expect(parseFromCanvas("42")).toBeNull();
  expect(parseFromCanvas(JSON.stringify({ kind: "focused" }))).toBeNull();
});

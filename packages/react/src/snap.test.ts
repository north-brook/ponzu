import { expect, test } from "bun:test";
import { snapMove, union } from "./snap.ts";

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

test("nothing near: the box moves as dragged", () => {
  const s = snapMove(box(0, 0), [box(1000, 1000)], 13, 7, 6);
  expect(s).toEqual({ dx: 13, dy: 7, guides: [], gaps: [] });
});

test("a left edge catches another board's left edge, with a guide down both", () => {
  // Dragged to x 304; the board below starts at 300.
  const s = snapMove(box(0, 0), [box(300, 400)], 304, 0, 6);
  expect(s.dx).toBe(300);
  expect(s.dy).toBe(0);
  expect(s.guides).toContainEqual({ axis: "x", at: 300, from: 0, to: 500 });
});

test("centres and far edges catch too, the nearest winning", () => {
  // Centre 50 + 147 = 197 is 3 from the other's centre at 200; its right edge 247 is 3 off 250.
  const s = snapMove(box(0, 0), [box(150, 300)], 147, 0, 6);
  expect(s.dx).toBe(150);
  // Top edge 2 off the other's bottom edge.
  const t = snapMove(box(0, 0), [box(0, 300, 100, 100)], 500, 398, 6);
  expect(t.dy).toBe(400);
});

test("boards sharing both edges get edge lines, not a centre line between them", () => {
  const s = snapMove(box(0, 0), [box(300, 400)], 302, 0, 6);
  expect(s.guides.map((g) => g.at).sort((a, b) => a - b)).toEqual([300, 400]);
  // A smaller board centred on it shares only the centre: that line shows.
  const c = snapMove(box(0, 0, 50, 50), [box(300, 400)], 323, 0, 6);
  expect(c.dx).toBe(325);
  expect(c.guides.map((g) => g.at)).toEqual([350]);
  // Sharing one edge, its centre on the other's far edge: both lines show.
  const h = snapMove(box(0, 0), [box(300, 400, 50, 100)], 302, 0, 6);
  expect(h.dx).toBe(300);
  expect(h.guides.map((g) => g.at).sort((a, b) => a - b)).toEqual([300, 350]);
});

test("beyond the threshold it doesn't snap", () => {
  const s = snapMove(box(0, 0), [box(300, 400)], 290, 0, 6);
  expect(s.dx).toBe(290);
  expect(s.guides).toEqual([]);
});

test("a locked axis stays put and never snaps", () => {
  const s = snapMove(box(0, 0), [box(302, 3)], 300, 0, 6, "y");
  expect(s.dy).toBe(0);
  expect(s.dx).toBe(302);
});

test("in a row, the box takes the spacing the row already uses", () => {
  // A and B sit 40 apart; the box dragged 43 to B's right lands 40 from it.
  const a = box(0, 0);
  const b = box(140, 0);
  const s = snapMove(box(0, 500), [a, b], 283, -500, 6);
  expect(s.dx).toBe(280);
  expect(s.dy).toBe(-500);
  expect(s.gaps).toContainEqual({ axis: "x", a: 100, b: 140, at: 50 });
  expect(s.gaps).toContainEqual({ axis: "x", a: 240, b: 280, at: 50 });
});

test("between two boards, the box centres itself in the room", () => {
  const s = snapMove(box(0, 500), [box(0, 0), box(400, 0)], 196, -500, 6);
  // Room is 400 - 100 - 100 = 200: 100 on each side.
  expect(s.dx).toBe(200);
  expect(s.gaps).toEqual([
    { axis: "x", a: 100, b: 200, at: 50 },
    { axis: "x", a: 300, b: 400, at: 50 },
  ]);
});

test("boards out of the row don't set its spacing", () => {
  // B is far below: no row with the box, so nothing to space against.
  const s = snapMove(box(0, 0), [box(-200, 0), box(-60, 900)], 43, 0, 2);
  expect(s.dx).toBe(43);
});

test("union spans every box", () => {
  expect(union([box(0, 0), box(200, 50, 10, 10)])).toEqual({ x: 0, y: 0, w: 210, h: 100 });
});

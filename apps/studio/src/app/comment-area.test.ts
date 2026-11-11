import { expect, test } from "bun:test";
import { AREA_WIDTH, OPEN_LIMIT, pictureArea, type Rect } from "./comment-area.ts";

const ASPECT = 3 / 2;
const landing: Rect = { x: 0, y: 0, w: 1440, h: 3200 };
const inside = (p: { x: number; y: number }, r: Rect) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
const within = (a: Rect, b: Rect) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

test("a pin on a button shows the button with room round it, not the whole board", () => {
  const pin = { x: 700, y: 520 };
  const button = { x: 640, y: 500, w: 120, h: 40 };
  const area = pictureArea({
    pin,
    boards: [landing],
    board: landing,
    node: button,
    aspect: ASPECT,
  })!;
  expect(area.w).toBe(AREA_WIDTH.min);
  expect(area.w / area.h).toBeCloseTo(ASPECT);
  expect(inside(pin, area)).toBe(true);
  expect(within(button, area)).toBe(true);
});

test("a pin on a section shows that section", () => {
  const pin = { x: 400, y: 900 };
  const section = { x: 0, y: 800, w: 1440, h: 600 };
  const area = pictureArea({
    pin,
    boards: [landing],
    board: landing,
    node: section,
    aspect: ASPECT,
  })!;
  expect(area.w).toBeGreaterThan(1440);
  expect(area.w).toBeLessThanOrEqual(AREA_WIDTH.max);
});

test("a pin on a big board with no node of its own shows a stretch of it, kept on the board", () => {
  // Near its top left corner: moved onto the board, as far as leaves the pin room to show.
  const pin = { x: 40, y: 30 };
  const area = pictureArea({ pin, boards: [landing], board: landing, node: null, aspect: ASPECT })!;
  expect(area.w).toBe(720);
  expect(area.x).toBeLessThanOrEqual(0);
  expect(area.x).toBeGreaterThan(-20);
  expect(area.y).toBeLessThanOrEqual(0);
  expect(area.y).toBeGreaterThan(-20);
  expect(inside(pin, area)).toBe(true);
  // Further in, all board.
  const further = pictureArea({
    pin: { x: 200, y: 120 },
    boards: [landing],
    board: landing,
    node: null,
    aspect: ASPECT,
  })!;
  expect([further.x, further.y]).toEqual([0, 0]);
});

test("a small board shows whole, centred, on its ground", () => {
  const card: Rect = { x: 100, y: 100, w: 320, h: 200 };
  const pin = { x: 120, y: 110 };
  const area = pictureArea({ pin, boards: [card], board: card, node: null, aspect: ASPECT })!;
  expect(within(card, area)).toBe(true);
  // Centred on the board, as near as the pin lets it be.
  expect(area.x + area.w / 2).toBeCloseTo(card.x + card.w / 2, 0);
  expect(inside(pin, area)).toBe(true);
});

test("a pin on the open canvas between two boards shows both, and the ground between", () => {
  const left: Rect = { x: 0, y: 0, w: 1440, h: 900 };
  const right: Rect = { x: 1640, y: 0, w: 1440, h: 900 };
  const pin = { x: 1540, y: 300 };
  const area = pictureArea({
    pin,
    boards: [left, right],
    board: null,
    node: null,
    aspect: ASPECT,
  })!;
  expect(area.x).toBeLessThan(left.x + left.w);
  expect(area.x + area.w).toBeGreaterThan(right.x);
  expect(inside(pin, area)).toBe(true);
  // Kept within the boards' height, not hanging below them.
  expect(area.y).toBeGreaterThanOrEqual(0);
  expect(area.y + area.h).toBeLessThanOrEqual(900);
});

test("a pin far from every board reaches the nearest, and never leaves the picture", () => {
  const board: Rect = { x: 0, y: 0, w: 800, h: 600 };
  const pin = { x: 1400, y: 300 };
  const area = pictureArea({ pin, boards: [board], board: null, node: null, aspect: ASPECT })!;
  expect(area.x).toBeLessThan(board.x + board.w);
  expect(inside(pin, area)).toBe(true);
});

test("a pin on the open canvas with no board in reach has no picture: it would be empty", () => {
  const board: Rect = { x: 0, y: 0, w: 1440, h: 900 };
  const far = { x: 5000, y: 5000 };
  expect(pictureArea({ pin: far, boards: [board], board: null, node: null, aspect: ASPECT })).toBe(
    null,
  );
  // Just past the reach, and just inside it.
  const past = { x: board.w + OPEN_LIMIT + 1, y: 300 };
  const within = { x: board.w + OPEN_LIMIT - 1, y: 300 };
  expect(pictureArea({ pin: past, boards: [board], board: null, node: null, aspect: ASPECT })).toBe(
    null,
  );
  const reached = pictureArea({
    pin: within,
    boards: [board],
    board: null,
    node: null,
    aspect: ASPECT,
  });
  expect(reached!.x).toBeLessThan(board.x + board.w);
  // Alone on an empty page.
  expect(pictureArea({ pin: far, boards: [], board: null, node: null, aspect: ASPECT })).toBe(null);
});

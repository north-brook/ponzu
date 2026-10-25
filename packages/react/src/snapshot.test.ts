import { expect, test } from "bun:test";
import {
  bucketFor,
  hash,
  holdsForLoops,
  MOTION_PX,
  overCap,
  PICTURE_AGAIN,
  PICTURE_SCALE,
  THAW_BUDGET,
  takeThaws,
  tierFor,
} from "./snapshot.tsx";

const base = {
  scale: 1,
  current: "live" as const,
  onScreen: true,
  pictures: true,
  pictured: true,
  motion: 0,
  looped: false,
  moving: false,
  attention: false,
};

test("a big board is live, a small one a picture, with room between", () => {
  expect(tierFor(base)).toBe("live");
  expect(tierFor({ ...base, scale: PICTURE_AGAIN * 0.9 })).toBe("picture");
  // Between the two lines, it stays what it is.
  const mid = (PICTURE_AGAIN + PICTURE_SCALE) / 2;
  expect(tierFor({ ...base, scale: mid })).toBe("live");
  expect(tierFor({ ...base, scale: mid, current: "picture" })).toBe("picture");
});

test("off screen is away, unless it has attention", () => {
  expect(tierFor({ ...base, onScreen: false })).toBe("away");
  expect(tierFor({ ...base, onScreen: false, attention: true })).toBe("live");
  expect(tierFor({ ...base, scale: 0.1, attention: true })).toBe("live");
});

test("a small board with motion big enough to see stays live, unless its loops can play it", () => {
  const small = { ...base, scale: 0.2 };
  expect(tierFor({ ...small, motion: MOTION_PX })).toBe("live");
  expect(tierFor({ ...small, motion: MOTION_PX - 1 })).toBe("picture");
  expect(tierFor({ ...small, motion: MOTION_PX, looped: true })).toBe("picture");
  // Mid-gesture it's a picture, and live again once the camera stops.
  expect(tierFor({ ...small, motion: MOTION_PX, moving: true })).toBe("picture");
});

test("a picture waits for the camera to stop before it thaws", () => {
  expect(tierFor({ ...base, current: "picture", moving: true })).toBe("picture");
  expect(tierFor({ ...base, current: "picture" })).toBe("live");
  // Back on screen mid-gesture: its picture if it has one, live if not.
  expect(tierFor({ ...base, current: "away", moving: true })).toBe("picture");
  expect(tierFor({ ...base, current: "away", moving: true, pictured: false })).toBe("live");
});

test("without pictures, boards on screen are live", () => {
  expect(tierFor({ ...base, scale: 0.1, pictures: false })).toBe("live");
  expect(tierFor({ ...base, onScreen: false, pictures: false })).toBe("away");
});

test("pictures are never upscaled", () => {
  expect(bucketFor(0.1)).toBe(0.25);
  expect(bucketFor(0.3)).toBe(0.5);
  expect(bucketFor(0.5)).toBe(0.5);
  expect(bucketFor(0.8)).toBe(1);
  expect(hash("a")).not.toBe(hash("b"));
});

const thaw = (name: string, rank: number, cost: number) => ({ name, rank, cost });

test("boards go live nearest the middle first, one heavy board per frame", () => {
  const queue = [
    thaw("far field", 900, 24_000),
    thaw("near footer", 10, 7_000),
    thaw("middle", 0, 6_500),
    thaw("small", 300, 120),
  ];
  const frames: string[][] = [];
  while (queue.length) frames.push(takeThaws(queue, THAW_BUDGET).map((t) => t.name));
  // Each heavy board gets a frame to itself; the cheap one rides with the next under budget.
  expect(frames).toEqual([["middle"], ["near footer"], ["small"], ["far field"]]);
});

test("small boards share a frame up to the budget", () => {
  const queue = [thaw("a", 1, 1500), thaw("b", 2, 1500), thaw("c", 3, 1500), thaw("d", 4, 100)];
  expect(takeThaws(queue, THAW_BUDGET).map((t) => t.name)).toEqual(["a", "b"]);
  expect(takeThaws(queue, THAW_BUDGET).map((t) => t.name)).toEqual(["c", "d"]);
  expect(queue).toEqual([]);
});

test("a mass of looping animation stays a picture with its loops playing, until hover or close up", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
  const field = [{ ids: ids(926) }, { ids: ids(8) }];
  const spinners = [{ ids: ids(6) }, { ids: ids(6) }, { ids: ids(6) }];
  const at = { scale: 0.64, attention: false, intent: false };
  expect(holdsForLoops({ regions: field, ...at })).toBe(true);
  // A few small loops (spinners, a caret) cost little live: no wait for a video.
  expect(holdsForLoops({ regions: spinners, ...at })).toBe(false);
  // Many small ones add up.
  expect(
    holdsForLoops({ regions: Array.from({ length: 30 }, () => ({ ids: ids(40) })), ...at }),
  ).toBe(true);
  // The pointer resting on it, selection or an agent, or drawn bigger than the loops were filmed: live.
  expect(holdsForLoops({ regions: field, ...at, intent: true })).toBe(false);
  expect(holdsForLoops({ regions: field, ...at, attention: true })).toBe(false);
  expect(holdsForLoops({ regions: field, ...at, scale: 1 })).toBe(false);
  expect(holdsForLoops({ regions: [], ...at })).toBe(false);
});

test("the picture cache drops the least recently used, never one on screen", () => {
  const keys = ["a", "b", "c", "d", "e"];
  // Two over: the oldest two go.
  expect(overCap(keys, 5, 3, () => false)).toEqual(["a", "b"]);
  // The oldest is on screen: the next ones go instead.
  expect(overCap(keys, 5, 3, (k) => k === "a")).toEqual(["b", "c"]);
  // Under the cap, nothing.
  expect(overCap(keys, 5, 8, () => false)).toEqual([]);
  // Everything on screen: nothing, over the cap or not.
  expect(overCap(keys, 5, 1, () => true)).toEqual([]);
});

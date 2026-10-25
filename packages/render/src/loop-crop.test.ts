import { expect, test } from "bun:test";
import { MAX_CAPTURE_PX } from "./capture.ts";
import { cropsFor, shareCaptures } from "./loop.ts";

test("crops follow the scale a capture is actually taken at", () => {
  const box = { x: 0, y: 100, width: 400, height: 300 };
  const regions = [{ track: 0, x: 0, y: 200, width: 400, height: 100 }];
  // Small enough to capture at the scale asked for.
  expect(cropsFor(box, regions, 1)).toEqual([{ track: 0, sx: 0, sy: 100, sw: 400, sh: 100 }]);
  // A box past the longest capture comes back smaller: the crop scales with it.
  const tall = { x: 0, y: 0, width: 400, height: MAX_CAPTURE_PX * 2 };
  const [c] = cropsFor(tall, [{ track: 1, x: 0, y: MAX_CAPTURE_PX, width: 400, height: 1000 }], 1);
  expect(c!.sy + c!.sh).toBeLessThanOrEqual(MAX_CAPTURE_PX);
  expect(c!.sy).toBeCloseTo(MAX_CAPTURE_PX / 2, -1);
  expect(c!.sh).toBeCloseTo(500, -1);
});

test("regions too far apart to share a capture are each charged their own", () => {
  // Eight sections down a tall board, all drifting on a 2 s cycle: one rate, eight captures each step.
  const tall = Array.from({ length: 8 }, (_, i) => ({
    x: 0,
    y: i * 3000,
    width: 1440,
    height: 1200,
    period: 2000,
  }));
  const plan = shareCaptures(tall, 1, 30);
  expect(plan.groups.length).toBe(8);
  expect(plan.captures).toBe(8 * 60);
  // Side by side they fit one capture, and share it.
  const near = tall.map((r, i) => ({ ...r, x: i * 50, y: 0, width: 40, height: 40 }));
  expect(shareCaptures(near, 1, 30).captures).toBe(60);
});

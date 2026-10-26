import { expect, test } from "bun:test";
import { MAX_CAPTURE_PX } from "./capture.ts";
import { cropsFor, filmLoops, shareCaptures } from "./loop.ts";
import type { FrameDriver } from "./motion.ts";

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

test("a film whose encoder fails fails, rather than leaving its loops still", async () => {
  // A page with one loop, whose encoder errors: answers by the call it gets.
  const page = (finish: unknown): FrameDriver => ({
    evaluate: async <T>(expression: string) => {
      const call = /__ponzu(?:Loop|Motion)\.(\w+)\([^)]*\)\)?$/.exec(expression)?.[1];
      if (call === "prepare") return { settled: 0, loops: true } as T;
      if (call === "plan")
        return {
          regions: [{ x: 0, y: 0, width: 40, height: 40, period: 100, ids: ["n"], animations: 1 }],
          still: [],
        } as T;
      if (call === "open") return "" as T;
      if (call === "finish") return finish as T;
      if (expression.includes("[data-artboard]")) return { x: 0, y: 0 } as T;
      return undefined as T;
    },
    capture: async () => new Uint8Array([1]),
    show: async () => {},
  });
  const broken = [{ error: "EncodingError: boom", description: "", samples: [], keys: [] }];
  await expect(filmLoops(page(broken), { scale: 1 })).rejects.toThrow("boom");
  const dropped = [{ error: null, description: "AA==", samples: ["AA=="], keys: [true] }];
  await expect(filmLoops(page(dropped), { scale: 1 })).rejects.toThrow("dropped frames");
});

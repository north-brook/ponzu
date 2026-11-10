import { expect, test } from "bun:test";
import { countPlaying, PACE_FROM, shouldPace } from "./pacer.tsx";
import { PACER_SRC } from "./pacer-src.ts";

const root = (videos: { paused: boolean; ended?: boolean }[]) =>
  ({
    querySelectorAll: () => videos.map((v) => ({ ended: false, ...v })),
  }) as unknown as ParentNode;

test("only playing videos count", () => {
  expect(countPlaying(root([]))).toBe(0);
  expect(countPlaying(root([{ paused: false }, { paused: true }, { paused: false }]))).toBe(2);
  expect(countPlaying(root([{ paused: false, ended: true }]))).toBe(0);
});

test("the pacer starts where viz starts throttling", () => {
  // VideoConferenceMatcher needs two videos; one video alone never caps the frame rate on desktop.
  expect(PACE_FROM).toBe(2);
});

test("it paces only when something besides video animates", () => {
  expect(shouldPace(1, true)).toBe(false);
  // Only video moving: the videos' rate is all anyone sees.
  expect(shouldPace(24, false)).toBe(false);
  expect(shouldPace(2, true)).toBe(true);
});

test("the pacer clip is a small inline webm", () => {
  expect(PACER_SRC.startsWith("data:video/webm;base64,")).toBe(true);
  const bytes = Buffer.from(PACER_SRC.slice(PACER_SRC.indexOf(",") + 1), "base64");
  // EBML header, so it's a real Matroska/WebM file.
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(bytes.length).toBeLessThan(10_000);
});

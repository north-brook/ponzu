import { expect, test } from "bun:test";
import { ease, PARTS, phase } from "./morph";

test("the design's ease-out: quick to start, slow to settle", () => {
  expect(ease(0)).toBe(0);
  expect(ease(1)).toBe(1);
  expect(ease(0.5)).toBeGreaterThan(0.85);
  for (let x = 0.05; x < 1; x += 0.05) expect(ease(x)).toBeGreaterThan(ease(x - 0.05));
});

test("going to voice, the waveform grows in after the switch", () => {
  // At the study's 19%: the field has stepped out of view, the waveform is on its way in.
  expect(phase(0.6, true, PARTS.wave)).toBeLessThan(1);
  expect(phase(0.1, true, PARTS.wave)).toBe(0);
  expect(phase(1, true, PARTS.mute)).toBe(1);
});

test("coming back to typing, the waveform and the mute leave first", () => {
  // The clock runs 1 → 0. At 0.4 (the study's 63%), the waveform and mute are gone.
  expect(phase(0.4, false, PARTS.wave)).toBe(0);
  expect(phase(0.4, false, PARTS.mute)).toBe(0);
  // Each part eases from the end it leaves: early in the way back it has barely moved.
  expect(phase(0.95, false, PARTS.sheet)).toBeGreaterThan(0.5);
});

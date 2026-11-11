/*
 * The ladder holds: every icon step paints about the same line, and no cloud component sets an
 * icon's size or stroke, or a colour the ladder retired, by hand.
 */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { ICON } from "./ladder.ts";

test("every icon step paints the same line, within a tenth of a pixel", () => {
  const lines = Object.values(ICON).map(({ size, stroke }) => (stroke * size) / 24);
  expect(Math.max(...lines) - Math.min(...lines)).toBeLessThanOrEqual(0.15);
  // Smaller steps are heavier, never lighter.
  const steps = Object.values(ICON);
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i]!.size).toBeLessThan(steps[i - 1]!.size);
    expect(steps[i]!.stroke).toBeGreaterThan(steps[i - 1]!.stroke);
  }
});

test("cloud icons are set by step, not by size and stroke", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const file of new Glob("**/*.tsx").scan(root)) {
    const src = await Bun.file(`${root}${file}`).text();
    for (const m of src.matchAll(/<Icon\b[^>]*?\b(size|stroke)=/g))
      offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
    if (/text-icon-strong/.test(src)) offenders.push(`${file}: text-icon-strong (retired)`);
    // One plus: Add01 draws a smaller cross than PlusSign in the same box, so the composer's +
    // read lighter than the zoom's beside it.
    if (/\bAdd01Icon\b/.test(src)) offenders.push(`${file}: Add01Icon (the plus is PlusSignIcon)`);
  }
  expect(offenders).toEqual([]);
});

test("the canvas's controls draw one plus and set text on whole pixels", async () => {
  const root = new URL("../../../../../packages/canvas/src/", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const file of new Glob("*.tsx").scan(root)) {
    const src = await Bun.file(`${root}${file}`).text();
    if (/<Icon name="add"/.test(src)) offenders.push(`${file}: name="add" (the plus is "plus")`);
    for (const m of src.matchAll(/text-\[\d+\.\d+px\]/g)) offenders.push(`${file}: ${m[0]}`);
  }
  expect(offenders).toEqual([]);
});

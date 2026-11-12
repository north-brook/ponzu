import { expect, test } from "bun:test";
import { ago, duration } from "./time.ts";

const NOW = Date.parse("2026-11-10T16:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

test("ages read short in dense lines and long in words", () => {
  expect(ago(before(30_000), NOW, "short")).toBe("just now");
  expect(ago(before(14 * MIN), NOW, "short")).toBe("14 m");
  expect(ago(before(2 * 60 * MIN), NOW, "short")).toBe("2 h");
  expect(ago(before(2 * 24 * 60 * MIN), NOW, "long")).toBe("2 days ago");
  expect(ago(before(21 * 24 * 60 * MIN), NOW, "long")).toBe("3 weeks ago");
  expect(ago(before(60 * MIN), NOW, "long")).toBe("1 hour ago");
  expect(ago(before(90 * 24 * 60 * MIN), NOW, "long")).toBe("3 months ago");
  expect(ago(before(14 * MIN), NOW, "compact")).toBe("14m");
  expect(ago(before(30_000), NOW, "compact")).toBe("now");
});

test("durations read as a check's row says them", () => {
  expect(duration(9_000)).toBe("9s");
  expect(duration(58_400)).toBe("58s");
  expect(duration(161_000)).toBe("2m 41s");
  expect(duration(185_000)).toBe("3m 05s");
  expect(duration(3_900_000)).toBe("1h 05m");
});

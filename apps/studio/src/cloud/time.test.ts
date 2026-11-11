import { expect, test } from "bun:test";
import { ago } from "./time.ts";

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
});

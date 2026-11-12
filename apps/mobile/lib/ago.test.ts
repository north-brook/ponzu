import { expect, test } from "bun:test";
import { shortAgo } from "./ago";

test("how long ago, as a comment says it", () => {
  const now = Date.UTC(2026, 10, 12, 12);
  expect(shortAgo(now - 20_000, now)).toBe("now");
  expect(shortAgo(now - 4 * 60_000, now)).toBe("4m");
  expect(shortAgo(now - 2 * 3_600_000, now)).toBe("2h");
  expect(shortAgo(now - 86_400_000, now)).toBe("1d");
  expect(shortAgo(Date.UTC(2026, 9, 14, 12), now)).toBe("Oct 14");
});

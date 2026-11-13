import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_API_URL, liveApiUrl } from "./session-file.ts";

test("a live test runs against dev unless PONZU_API_URL names another API", () => {
  expect(DEV_API_URL).toBe("https://api-dev.ponzu.design");
  expect(liveApiUrl({})).toBe(DEV_API_URL);
  // Empty is unset.
  expect(liveApiUrl({ PONZU_API_URL: "" })).toBe(DEV_API_URL);
  expect(liveApiUrl({ PONZU_API_URL: "https://api.ponzu.design/" })).toBe(
    "https://api.ponzu.design",
  );
});

test("every live test takes its address from liveApiUrl, and none names production's", () => {
  // After launch api.ponzu.design is production: a live test reaches it only when told to.
  const dir = join(import.meta.dir, "..");
  const live = readdirSync(dir).filter((name) => name.endsWith(".live.test.ts"));
  expect(live.length).toBeGreaterThan(0);
  for (const name of live) {
    const text = readFileSync(join(dir, name), "utf8");
    expect([name, text.includes("api.ponzu.design")]).toEqual([name, false]);
    if (text.includes("PONZU_API_URL ??")) throw new Error(`${name} reads PONZU_API_URL itself`);
    if (text.includes("createSession("))
      expect([name, text.includes("liveApiUrl(")]).toEqual([name, true]);
  }
});

import { expect, test } from "bun:test";
import { isAssetKey, isId, newAssetKey, newId, randomString } from "./ids.ts";

test("an id says what it is and is not guessable from another", () => {
  const ids = Array.from({ length: 1000 }, () => newId("cnv"));

  for (const id of ids) expect(id).toMatch(/^cnv_[0-9a-hjkmnp-tv-z]{16}$/);
  expect(new Set(ids).size).toBe(1000);
});

test("random strings use the whole alphabet evenly", () => {
  const counts = new Map<string, number>();
  for (const char of randomString(32_000)) counts.set(char, (counts.get(char) ?? 0) + 1);

  // 32 characters, 1000 expected of each. A biased mapping from bytes would miss by far more.
  expect(counts.size).toBe(32);
  for (const count of counts.values()) {
    expect(count).toBeGreaterThan(800);
    expect(count).toBeLessThan(1200);
  }
});

test("an id a caller chose is taken only in the shape newId makes", () => {
  expect(isId("ti", newId("ti"))).toBe(true);
  expect(isId("q", "q_0123456789abcdef")).toBe(true);
  expect(isId("q", "ti_0123456789abcdef")).toBe(false);
  expect(isId("q", "q_0123456789abcdeF")).toBe(false);
  // i, l, o and u are not in the alphabet.
  expect(isId("q", "q_0123456789abcdei")).toBe(false);
  expect(isId("q", "q_0123456789abcde")).toBe(false);
  expect(isId("q", "q_0123456789abcdef0")).toBe(false);
});

test("an asset key is taken only in the shape newAssetKey makes", () => {
  const key = newAssetKey();
  expect(key).toMatch(/^[0-9a-hjkmnp-tv-z]{32}$/);
  expect(isAssetKey(key)).toBe(true);
  expect(isAssetKey(key.slice(1))).toBe(false);
  expect(isAssetKey(`${key}0`)).toBe(false);
  expect(isAssetKey(`${key}/`)).toBe(false);
  expect(isAssetKey(key.replace(/^./, "u"))).toBe(false);
  expect(isAssetKey(key.toUpperCase())).toBe(false);
  expect(isAssetKey("")).toBe(false);
});

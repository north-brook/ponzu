import { describe, expect, test } from "bun:test";
import { isStorable, scrubbed, toStorableJson } from "./text.ts";

// Written with escapes so that this file itself holds none of them.
const NUL = "\u0000";
const HIGH = "\ud83d";
const LOW = "\ude00";

describe("isStorable", () => {
  test("accepts ordinary text, whole pairs and the other control characters", () => {
    expect(isStorable({ text: "plain", emoji: `${HIGH}${LOW}`, tab: "\t\u0001\u001f" })).toBe(true);
    expect(isStorable([1, true, null, { nested: ["ok"] }])).toBe(true);
    // The six characters a backslash, a `u` and four zeros are text like any other.
    expect(isStorable({ text: "\\u0000 and \\ud83d" })).toBe(true);
  });

  test("refuses a NUL or half a pair, wherever it is", () => {
    expect(isStorable({ text: `a${NUL}b` })).toBe(false);
    expect(isStorable({ text: `cut ${HIGH}` })).toBe(false);
    expect(isStorable({ text: `${LOW} cut` })).toBe(false);
    expect(isStorable({ text: `${LOW}${HIGH}` })).toBe(false);
    expect(isStorable({ deep: [{ list: ["fine", `${HIGH}x`] }] })).toBe(false);
    expect(isStorable({ [`key${NUL}`]: "fine" })).toBe(false);
    expect(isStorable(NUL)).toBe(false);
  });
});

describe("toStorableJson", () => {
  test("is the value's own json text, keys in the order written", () => {
    const value = { zebra: 1, apple: [`${HIGH}${LOW}`], mango: { b: 1, a: 2 } };
    expect(toStorableJson(value)).toBe(JSON.stringify(value));
    expect(toStorableJson({ text: NUL })).toBeNull();
  });
});

describe("scrubbed", () => {
  test("hands back the very same value when there is nothing to replace", () => {
    const value = { text: "fine", list: [`${HIGH}${LOW}`] };
    expect(scrubbed(value)).toBe(value);
  });

  test("replaces each NUL and lone half with U+FFFD, in values and in keys, and nothing else", () => {
    const value = {
      output: `a${NUL}b${NUL}`,
      [`k${HIGH}`]: [`${LOW}`, `whole ${HIGH}${LOW}`, 7, null],
      kept: { nested: `${HIGH}${HIGH}${LOW}` },
    };

    expect<unknown>(scrubbed(value)).toEqual({
      output: "a\ufffdb\ufffd",
      "k\ufffd": ["\ufffd", `whole ${HIGH}${LOW}`, 7, null],
      kept: { nested: `\ufffd${HIGH}${LOW}` },
    });
    expect(isStorable(scrubbed(value))).toBe(true);
  });
});

import { expect, test } from "bun:test";
import { redact, redactText } from "./redact.ts";

test("what a secret looks like is taken out of text", () => {
  expect(redactText("Authorization: Bearer abc.def and ghp_0123456789abcdef0123")).toBe(
    "Authorization: [redacted] and [redacted]",
  );
  expect(redactText("ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdefghij")).toBe(
    "ANTHROPIC_API_KEY=[redacted]",
  );
  expect(redactText("postgres://ponzu:hunter2@db.example/ponzu")).toBe(
    "postgres://ponzu:[redacted]@db.example/ponzu",
  );
});

test("a value known to be secret goes wherever it is, unless it is too short to look for", () => {
  expect(redactText("key: abcdefgh12345678, flag: 1", ["abcdefgh12345678", "1"])).toBe(
    "key: [redacted], flag: 1",
  );
  // One secret inside a longer one: the longer goes whole.
  expect(redactText("x=abcdefgh-suffix", ["abcdefgh", "abcdefgh-suffix"])).toBe("x=[redacted]");
});

test("a value is copied with every secret out, by name or by look, to the depth asked", () => {
  const deep = { a: { b: { c: { d: "abcdefgh12345678" } } } };
  expect(redact({ accessToken: "x", note: "pzr_0123456789abcdef01", n: 3n })).toEqual({
    accessToken: "[redacted]",
    note: "[redacted]",
    n: "3",
  });
  expect(redact(deep, { known: ["abcdefgh12345678"], maxDepth: 2 })).toEqual({
    a: { b: "[too deep]" },
  });
  expect(redact(deep, { known: ["abcdefgh12345678"] })).toEqual({
    a: { b: { c: { d: "[redacted]" } } },
  });
});

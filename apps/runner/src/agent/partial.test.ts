import { expect, test } from "bun:test";
import { PartialInput } from "./partial.ts";

/** Feeds `json` a character at a time, noting the input each time more can be read. */
function reads(json: string): unknown[] {
  const p = new PartialInput();
  const out: unknown[] = [];
  for (const c of json) if (p.feed(c)) out.push(p.value());
  return out;
}

test("each complete member, in order, never a half-written one", () => {
  expect(reads('{"target": "ab_1", "html": "<p>Hi, \\"you\\"</p>", "mode": "append"}')).toEqual([
    { target: "ab_1" },
    { target: "ab_1", html: '<p>Hi, "you"</p>' },
    { target: "ab_1", html: '<p>Hi, "you"</p>', mode: "append" },
  ]);
});

test("numbers, booleans and nested values are read once complete", () => {
  expect(
    reads('{"width": 320, "flag": true, "updates": [{"id": "n_1", "text": "a,b"}], "x": 1}'),
  ).toEqual([
    { width: 320 },
    { width: 320, flag: true },
    { width: 320, flag: true, updates: [{ id: "n_1" }] },
    { width: 320, flag: true, updates: [{ id: "n_1", text: "a,b" }] },
    { width: 320, flag: true, updates: [{ id: "n_1", text: "a,b" }] },
    { width: 320, flag: true, updates: [{ id: "n_1", text: "a,b" }] },
    { width: 320, flag: true, updates: [{ id: "n_1", text: "a,b" }], x: 1 },
  ]);
});

test("a key on its own, or a string still open, is not read", () => {
  const p = new PartialInput();
  expect(p.feed('{"command": "git commit -m \\"Add')).toBe(false);
  expect(p.value()).toBeNull();
  expect(p.feed(' card\\""')).toBe(true);
  expect(p.value()).toEqual({ command: 'git commit -m "Add card"' });
});

test("a huge input is kept only so far, and costs one look per character", () => {
  const p = new PartialInput();
  p.feed('{"file_path": "a.ts", "content": "');
  for (let i = 0; i < 2_000; i++) expect(p.feed("x".repeat(100))).toBe(false);
  expect(p.value()).toEqual({ file_path: "a.ts" });
});

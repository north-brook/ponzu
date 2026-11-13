import { expect, test } from "bun:test";
import type { ThreadItem } from "../cloud/model.ts";
import { keepLines, type LineSource } from "./thread-lines.ts";

const said = (id: string, text: string): ThreadItem => ({
  id,
  seq: Number(id.slice(1)),
  at: "2026-11-13T09:00:00.000Z",
  streaming: false,
  kind: "assistant",
  payload: { text },
});

/** Lines made from rows, counting how many were made. */
function lines(rows: { id: string; text: string }[], extra: unknown = null) {
  let made = 0;
  const sources: LineSource[] = rows.map((row) => ({
    id: row.id,
    from: [row, extra],
    make: () => {
      made++;
      return said(row.id, row.text);
    },
  }));
  return { sources, made: () => made };
}

test("a line whose row is the same is the same object, and isn't made again", () => {
  const a = { id: "i1", text: "One" };
  const b = { id: "i2", text: "Two" };
  const first = keepLines(null, lines([a, b]).sources);

  const c = { id: "i3", text: "Three" };
  const next = lines([a, b, c]);
  const second = keepLines(first, next.sources);
  expect(second.items[0]).toBe(first.items[0]!);
  expect(second.items[1]).toBe(first.items[1]!);
  expect(next.made()).toBe(1);
  expect(second.items[2]).toEqual(said("i3", "Three"));
});

test("a line made again that comes out the same is the object it was", () => {
  const first = keepLines(null, lines([{ id: "i1", text: "One" }]).sources);
  // A new row object with the same words (Realtime's whole result), and what it reads changed.
  const next = lines([{ id: "i1", text: "One" }], "pages changed");
  const second = keepLines(first, next.sources);
  expect(next.made()).toBe(1);
  expect(second.items[0]).toBe(first.items[0]!);
  // Nothing changed at all: the list itself is the one before.
  expect(second.items).toBe(first.items);
});

test("only the line that changed is a new object", () => {
  const a = { id: "i1", text: "One" };
  const first = keepLines(null, lines([a, { id: "i2", text: "Two" }]).sources);
  const second = keepLines(first, lines([a, { id: "i2", text: "Two, edited" }]).sources);
  expect(second.items[0]).toBe(first.items[0]!);
  expect(second.items[1]).not.toBe(first.items[1]!);
  expect(second.items[1]).toEqual(said("i2", "Two, edited"));
  expect(second.items).not.toBe(first.items);
});

test("a line that goes is forgotten", () => {
  const a = { id: "i1", text: "One" };
  const first = keepLines(null, lines([a, { id: "i2", text: "Two" }]).sources);
  const second = keepLines(first, lines([a]).sources);
  expect([...second.made.keys()]).toEqual(["i1"]);
  expect(second.items).toEqual([said("i1", "One")]);
});

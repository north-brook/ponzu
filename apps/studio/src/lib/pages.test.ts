import { afterAll, beforeEach, expect, test } from "bun:test";
import { loadPages, savePage } from "./pages";

const store = new Map<string, string>();
const real = globalThis.localStorage;
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
} as Storage;

beforeEach(() => store.clear());
afterAll(() => {
  globalThis.localStorage = real;
});

test("each design keeps the page it was last on", () => {
  savePage("a.design", "p2");
  savePage("b.design", "p1");
  savePage("a.design", "p3");
  expect(loadPages()).toEqual({ "a.design": "p3", "b.design": "p1" });
});

test("anything but page ids in storage counts as nothing saved", () => {
  for (const bad of ["null", "[]", "3", "{"]) {
    store.set("ponzu.pages", bad);
    expect(loadPages()).toEqual({});
  }
  store.set("ponzu.pages", JSON.stringify({ a: "p1", b: 2, c: null }));
  expect(loadPages()).toEqual({ a: "p1" });
});

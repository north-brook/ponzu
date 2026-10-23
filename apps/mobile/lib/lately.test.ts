import { expect, mock, test } from "bun:test";

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
const { KEEP, rememberOpened, rememberSearch } = await import("./lately");

const empty = { searches: [], opened: [] };

test("searches: newest first, each once whatever its case, a few at most", () => {
  let l = rememberSearch(empty, " brand ");
  l = rememberSearch(l, "logo");
  l = rememberSearch(l, "Brand");
  expect(l.searches).toEqual(["Brand", "logo"]);
  expect(rememberSearch(l, "   ")).toBe(l);
  for (let i = 0; i < 10; i++) l = rememberSearch(l, `q${i}`);
  expect(l.searches.length).toBe(KEEP.searches);
  expect(l.searches[0]).toBe("q9");
});

test("opened: newest first, a design once with its latest page, three at most", () => {
  let l = rememberOpened(empty, { mac: "a", key: "k1", page: "p1", at: 1 });
  l = rememberOpened(l, { mac: "a", key: "k2", at: 2 });
  l = rememberOpened(l, { mac: "a", key: "k1", page: "p2", at: 3 });
  expect(l.opened.map((o) => [o.key, o.page])).toEqual([
    ["k1", "p2"],
    ["k2", undefined],
  ]);
  l = rememberOpened(l, { mac: "b", key: "k1", at: 4 });
  l = rememberOpened(l, { mac: "b", key: "k3", at: 5 });
  expect(l.opened.length).toBe(KEEP.opened);
  expect(l.opened.map((o) => `${o.mac}:${o.key}`)).toEqual(["b:k3", "b:k1", "a:k1"]);
});

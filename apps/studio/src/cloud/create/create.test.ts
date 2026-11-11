import { expect, test } from "bun:test";
import type { Repo } from "../model.ts";
import { canSend, pickerRows, SEARCH_FROM, showsSearch } from "./create.ts";

test("a prompt sends once it says something, and not while it is sending", () => {
  expect(canSend("", false)).toBe(false);
  expect(canSend("  \n ", false)).toBe(false);
  expect(canSend("Three takes on the hero", false)).toBe(true);
  expect(canSend("Three takes on the hero", true)).toBe(false);
});

const repo = (name: string): Repo => ({ id: `repo_${name}`, owner: "north-brook", name });
const repos = [repo("fernwood"), repo("site"), repo("lenny")];

test("the picker lists Scratch, then the repos in their order", () => {
  expect(pickerRows(repos, "")).toEqual({ scratch: true, repos });
});

test("a query keeps the repos whose name has it, and Scratch only when it matches", () => {
  expect(pickerRows(repos, "LEN")).toEqual({ scratch: false, repos: [repo("lenny")] });
  expect(pickerRows(repos, "  len ").repos.map((r) => r.name)).toEqual(["lenny"]);
  // The owner is the workspace's, the same on every repo: it isn't searched.
  expect(pickerRows(repos, "north").repos).toEqual([]);
  expect(pickerRows(repos, "scr")).toEqual({ scratch: true, repos: [] });
});

test("the search shows only once there are enough repos to need it", () => {
  const some = (n: number) => Array.from({ length: n }, (_, i) => repo(`r${i}`));
  expect(showsSearch(null)).toBe(false);
  expect(showsSearch([])).toBe(false);
  expect(showsSearch(some(SEARCH_FROM - 1))).toBe(false);
  expect(showsSearch(some(SEARCH_FROM))).toBe(true);
});

import { expect, test } from "bun:test";
import type { Repo } from "../model.ts";
import { canSend, pickerRows } from "./create.ts";

test("a prompt sends once it says something, and not while it is sending", () => {
  expect(canSend("", false)).toBe(false);
  expect(canSend("  \n ", false)).toBe(false);
  expect(canSend("Three takes on the hero", false)).toBe(true);
  expect(canSend("Three takes on the hero", true)).toBe(false);
});

const repo = (owner: string, name: string): Repo => ({ id: `${owner}/${name}`, owner, name });
const repos = [
  repo("north-brook", "fernwood"),
  repo("fablefuel", "site"),
  repo("north-brook", "lenny"),
];

test("the picker groups repos by owner, keeping their order", () => {
  const rows = pickerRows(repos, "");
  expect(rows.scratch).toBe(true);
  expect(rows.groups.map((g) => [g.owner, g.repos.map((r) => r.name)])).toEqual([
    ["north-brook", ["fernwood", "lenny"]],
    ["fablefuel", ["site"]],
  ]);
});

test("a query keeps what names it, by repo or owner, and Scratch only when it matches", () => {
  expect(pickerRows(repos, "LEN").groups.flatMap((g) => g.repos.map((r) => r.name))).toEqual([
    "lenny",
  ]);
  expect(pickerRows(repos, "LEN").scratch).toBe(false);
  expect(pickerRows(repos, "fable").groups.map((g) => g.owner)).toEqual(["fablefuel"]);
  expect(pickerRows(repos, "scr")).toEqual({ scratch: true, groups: [] });
});

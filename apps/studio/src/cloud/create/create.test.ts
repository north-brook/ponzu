import { expect, test } from "bun:test";
import type { Repo } from "../model.ts";
import {
  BETWEEN,
  canSend,
  fullName,
  HEADING,
  heldWhileOpen,
  LIST_ROOM,
  listHeight,
  type PickerGroup,
  pickerGroups,
  projectLabel,
  projectName,
  ROW,
  type Shelf,
  searchAtOpening,
} from "./create.ts";

test("a prompt sends once it says something, and not while it is sending", () => {
  expect(canSend("", false)).toBe(false);
  expect(canSend("  \n ", false)).toBe(false);
  expect(canSend("Three takes on the hero", false)).toBe(true);
  expect(canSend("Three takes on the hero", true)).toBe(false);
});

const repo = (name: string, owner = "north-brook"): Repo => ({
  id: `repo_${owner}_${name}`,
  owner,
  name,
});
const repos = [repo("fernwood"), repo("site"), repo("lenny")];
const lenny = [repo("app", "lennylearning"), repo("site", "lennylearning")];
const mine = [repo("dotfiles", "brycedbjork")];
const here = (list: Repo[] | null = repos): Shelf => ({
  workspaceId: null,
  name: "Northbrook",
  repos: list,
});
const lennyShelf = (list: Repo[] | null = lenny): Shelf => ({
  workspaceId: "ws_lenny",
  name: "Lenny Learning",
  repos: list,
});
const personal = (list: Repo[] | null = mine): Shelf => ({
  workspaceId: "ws_bryce",
  name: "Personal",
  repos: list,
});

/** Each group as `heading: rows`, a row being its full name, Scratch, or … while loading. */
const read = (groups: PickerGroup[]) =>
  groups.map((g) => [
    g.heading,
    [...(g.scratch ? ["Scratch"] : []), ...g.repos.map(fullName), ...(g.loading ? ["…"] : [])],
  ]);

test("a repo is titled by its owner and name; Scratch by itself, and named for its workspace", () => {
  expect(fullName(repo("fernwood"))).toBe("north-brook/fernwood");
  expect(projectLabel({ kind: "repo", repo: repo("app", "lennylearning") })).toBe(
    "lennylearning/app",
  );
  expect(projectLabel({ kind: "scratch" })).toBe("Scratch");
  expect(projectName({ kind: "scratch" }, "Lenny Learning")).toBe(
    "Project: Scratch in Lenny Learning",
  );
  expect(projectName({ kind: "scratch" }, null)).toBe("Project: Scratch");
  expect(projectName({ kind: "repo", repo: repo("site") }, "Northbrook")).toBe(
    "Project: north-brook/site",
  );
});

test("with one workspace the list is Scratch and its repos, with no heading", () => {
  expect(read(pickerGroups([here()], ""))).toEqual([
    [null, ["Scratch", "north-brook/fernwood", "north-brook/site", "north-brook/lenny"]],
  ]);
  // Its repos still loading: Scratch, and their place held.
  expect(read(pickerGroups([here(null)], ""))).toEqual([[null, ["Scratch", "…"]]]);
});

test("with several, a group for each, the window's first and then the switcher's order", () => {
  const groups = pickerGroups([here(), lennyShelf(), personal()], "");
  expect(read(groups)).toEqual([
    ["Northbrook", ["Scratch", "north-brook/fernwood", "north-brook/site", "north-brook/lenny"]],
    ["Lenny Learning", ["Scratch", "lennylearning/app", "lennylearning/site"]],
    ["Personal", ["Scratch", "brycedbjork/dotfiles"]],
  ]);
  expect(groups.map((g) => g.workspaceId)).toEqual([null, "ws_lenny", "ws_bryce"]);
  // A workspace's heading and Scratch are there before its repos are, and one whose repos
  // couldn't be had (given none) still offers its Scratch.
  expect(read(pickerGroups([here(), lennyShelf(null), personal([])], ""))).toEqual([
    ["Northbrook", ["Scratch", "north-brook/fernwood", "north-brook/site", "north-brook/lenny"]],
    ["Lenny Learning", ["Scratch", "…"]],
    ["Personal", ["Scratch"]],
  ]);
  // A repo two workspaces share is listed once, as the first's.
  expect(read(pickerGroups([here(), lennyShelf([repos[0]!])], ""))[1]).toEqual([
    "Lenny Learning",
    ["Scratch"],
  ]);
});

test("a query matches anywhere in owner/name, every Scratch, and a workspace's name", () => {
  const shelves = [here(), lennyShelf(), personal()];
  const q = (query: string) => read(pickerGroups(shelves, query));
  // An owner, and the slash: only the groups with a match, headings and all.
  expect(q("lennylearning/")).toEqual([
    ["Lenny Learning", ["lennylearning/app", "lennylearning/site"]],
  ]);
  expect(q("  SITE ")).toEqual([
    ["Northbrook", ["north-brook/site"]],
    ["Lenny Learning", ["lennylearning/site"]],
  ]);
  expect(q("brook/fern")).toEqual([["Northbrook", ["north-brook/fernwood"]]]);
  // Scratch is in every workspace.
  expect(q("scr")).toEqual([
    ["Northbrook", ["Scratch"]],
    ["Lenny Learning", ["Scratch"]],
    ["Personal", ["Scratch"]],
  ]);
  // A workspace's name finds its Scratch and all its repos; a repo's name, that repo.
  expect(q("lenny")).toEqual([
    ["Northbrook", ["north-brook/lenny"]],
    ["Lenny Learning", ["Scratch", "lennylearning/app", "lennylearning/site"]],
  ]);
  expect(q("personal")).toEqual([["Personal", ["Scratch", "brycedbjork/dotfiles"]]]);
  expect(q("nothing like it")).toEqual([]);
  // A workspace still loading has nothing to show for a search yet.
  expect(read(pickerGroups([here(), lennyShelf(null)], "app"))).toEqual([]);
  // With one workspace there is no heading to name it: its name finds only what it says.
  expect(read(pickerGroups([here()], "northbrook"))).toEqual([]);
});

test("an open list takes only the last workspace's repos, at its foot", () => {
  const opened = [here(), lennyShelf(null), personal(null)];
  const now = [here(), lennyShelf(), personal()];
  // Lenny Learning's answered while it was open: they wait, as they would push Personal down.
  // Personal's join, below everything there was.
  expect(read(pickerGroups(heldWhileOpen(opened, now), ""))).toEqual([
    ["Northbrook", ["Scratch", "north-brook/fernwood", "north-brook/site", "north-brook/lenny"]],
    ["Lenny Learning", ["Scratch"]],
    ["Personal", ["Scratch", "brycedbjork/dotfiles"]],
  ]);
  // Opened again, every workspace lists what it has.
  expect(heldWhileOpen(now, now)).toEqual(now);
  // With one workspace, its repos are the foot: they replace their placeholder.
  expect(heldWhileOpen([here(null)], [here()])).toEqual([here()]);
});

test("the list is as tall as its rows and headings, and has a search whenever it would scroll", () => {
  expect(LIST_ROOM).toBe(176);
  const one = (n: number) =>
    pickerGroups([here(Array.from({ length: n }, (_, i) => repo(`r${i}`)))], "");
  // Scratch and four repos fit; a fifth would scroll.
  expect(listHeight(one(4))).toBe(5 * ROW);
  expect(searchAtOpening(one(4))).toBe(false);
  expect(searchAtOpening(one(5))).toBe(true);
  // While the window's own repos are coming they may come to scroll it.
  expect(searchAtOpening(pickerGroups([here(null)], ""))).toBe(true);
  // Two workspaces and one repo: two headings, the rule between them, three rows.
  const two = pickerGroups([here([repos[0]!]), lennyShelf([])], "");
  expect(listHeight(two)).toBe(2 * HEADING + BETWEEN + 3 * ROW);
  expect(searchAtOpening(two)).toBe(false);
  // Headings count: a repo each is four rows, which alone would fit, but not with theirs.
  const counted = pickerGroups([here([repos[0]!]), lennyShelf([lenny[0]!])], "");
  expect(listHeight(counted)).toBe(2 * HEADING + BETWEEN + 4 * ROW);
  expect(4 * ROW).toBeLessThan(LIST_ROOM);
  expect(searchAtOpening(counted)).toBe(true);
  // The last workspace still loading: its repos join while open, so it has a search.
  expect(searchAtOpening(pickerGroups([here([]), lennyShelf(null)], ""))).toBe(true);
  // Another one loading as it opened doesn't join while open: no placeholder row is counted.
  const opened = [here([]), lennyShelf(null), personal([])];
  expect(listHeight(pickerGroups(heldWhileOpen(opened, opened), ""))).toBe(
    3 * HEADING + 2 * BETWEEN + 3 * ROW,
  );
});

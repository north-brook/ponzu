import { expect, test } from "bun:test";
import type { Repo } from "../model.ts";
import {
  canSend,
  fullName,
  pickerRepos,
  pickerRows,
  projectLabel,
  SEARCH_FROM,
  showsSearch,
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

test("a repo is titled by its owner and name; Scratch by itself", () => {
  expect(fullName(repo("fernwood"))).toBe("north-brook/fernwood");
  expect(projectLabel({ kind: "repo", repo: repo("app", "lennylearning") })).toBe(
    "lennylearning/app",
  );
  expect(projectLabel({ kind: "scratch" })).toBe("Scratch");
});

test("the window's workspace's repos come first, then each other's in the switcher's order", () => {
  const rows = pickerRepos(repos, [
    { workspaceId: "ws_lenny", repos: lenny },
    { workspaceId: "ws_bryce", repos: mine },
  ]);
  expect(rows.map((r) => [fullName(r.repo), r.workspaceId])).toEqual([
    ["north-brook/fernwood", null],
    ["north-brook/site", null],
    ["north-brook/lenny", null],
    ["lennylearning/app", "ws_lenny"],
    ["lennylearning/site", "ws_lenny"],
    ["brycedbjork/dotfiles", "ws_bryce"],
  ]);
  // Still loading here: the others' still show, after where these will be.
  expect(pickerRepos(null, [{ workspaceId: "ws_bryce", repos: mine }]).length).toBe(1);
  // A repo two workspaces share is listed once, as the first's.
  expect(pickerRepos(repos, [{ workspaceId: "ws_x", repos: [repos[0]!] }]).length).toBe(3);
});

test("the picker lists Scratch, then the repos in their order", () => {
  const rows = pickerRepos(repos);
  expect(pickerRows(rows, "")).toEqual({ scratch: true, repos: rows });
});

test("a query matches anywhere in owner/name, and Scratch only when it matches", () => {
  const rows = pickerRepos(repos, [{ workspaceId: "ws_lenny", repos: lenny }]);
  const names = (q: string) => pickerRows(rows, q).repos.map((r) => fullName(r.repo));
  expect(names("LEN")).toEqual(["north-brook/lenny", "lennylearning/app", "lennylearning/site"]);
  expect(names("  site ")).toEqual(["north-brook/site", "lennylearning/site"]);
  // The owner is searched too, and the slash between them.
  expect(names("lennylearning/")).toEqual(["lennylearning/app", "lennylearning/site"]);
  expect(names("brook/fern")).toEqual(["north-brook/fernwood"]);
  expect(pickerRows(rows, "scr")).toEqual({ scratch: true, repos: [] });
  expect(pickerRows(rows, "len").scratch).toBe(false);
});

test("the search shows only once there are enough repos to need it", () => {
  expect(showsSearch(0)).toBe(false);
  expect(showsSearch(SEARCH_FROM - 1)).toBe(false);
  expect(showsSearch(SEARCH_FROM)).toBe(true);
});

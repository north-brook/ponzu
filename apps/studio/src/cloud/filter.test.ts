import { expect, test } from "bun:test";
import { applyFilter, isFiltering, NO_FILTER, repoCounts, toggleRepo } from "./filter.ts";
import type { DesignSummary, Person, Repo } from "./model.ts";

const repo = (name: string): Repo => ({ id: name, owner: "north-brook", name });
const person = (id: string): Person => ({ id, name: id, login: id, avatarUrl: null });
const design = (id: string, owner: string, repoName: string | null): DesignSummary => ({
  id,
  name: id,
  project: repoName
    ? { kind: "repo", repo: repo(repoName), branch: `pz/${id}` }
    : { kind: "scratch", city: "oslo" },
  preview: null,
  status: "active",
  agentState: "idle",
  needsYou: 0,
  unseen: false,
  pullRequest: null,
  hereNow: [],
  owner: person(owner),
  lastActivityAt: "2026-11-10T12:00:00.000Z",
  settledAt: null,
});

const designs = [
  design("a", "sam", "fernwood"),
  design("b", "maya", "fernwood"),
  design("c", "sam", "lenny"),
  design("d", "sam", null),
];
const ids = (list: DesignSummary[]) => list.map((d) => d.id);
const ALL = ["fernwood", "lenny"];

test("no filter keeps everything, Scratch included", () => {
  expect(ids(applyFilter(designs, NO_FILTER))).toEqual(["a", "b", "c", "d"]);
  expect(isFiltering(NO_FILTER)).toBe(false);
});

test("a person keeps the designs they started", () => {
  expect(ids(applyFilter(designs, { person: "sam", repos: null }))).toEqual(["a", "c", "d"]);
});

test("repos keep their designs and drop Scratch", () => {
  const filter = toggleRepo(NO_FILTER, "fernwood", ALL);
  expect(filter.repos).toEqual(["lenny"]);
  expect(isFiltering(filter)).toBe(true);
  expect(ids(applyFilter(designs, filter))).toEqual(["c"]);
  expect(ids(applyFilter(designs, { person: "sam", repos: ["fernwood"] }))).toEqual(["a"]);
});

test("checking every repo again, or unchecking the last, is no filter", () => {
  const one = toggleRepo(NO_FILTER, "fernwood", ALL);
  expect(toggleRepo(one, "fernwood", ALL).repos).toBeNull();
  expect(toggleRepo(one, "lenny", ALL).repos).toBeNull();
});

test("repo counts cover the repos with designs, most first", () => {
  expect(repoCounts(designs).map((r) => [r.repo.name, r.count])).toEqual([
    ["fernwood", 2],
    ["lenny", 1],
  ]);
});

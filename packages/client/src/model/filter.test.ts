import { expect, test } from "bun:test";
import {
  applyFilter,
  isFiltering,
  NO_FILTER,
  projectCounts,
  projectKey,
  pruneFilter,
  readFilter,
  repoKey,
  SCRATCH,
  toggleProject,
} from "./filter.ts";
import type { CanvasSummary, Person, Repo } from "./model.ts";

const repo = (name: string): Repo => ({ id: name, owner: "north-brook", name });
const person = (id: string): Person => ({ id, name: id, login: id, avatarUrl: null });
const canvas = (id: string, owner: string, repoName: string | null): CanvasSummary => ({
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

const canvases = [
  canvas("a", "sam", "fernwood"),
  canvas("b", "maya", "fernwood"),
  canvas("c", "sam", "lenny"),
  canvas("d", "sam", null),
];
const ids = (list: CanvasSummary[]) => list.map((d) => d.id);
const FERNWOOD = projectKey(canvases[0]!.project);
const LENNY = projectKey(canvases[2]!.project);
const ALL = [FERNWOOD, LENNY, SCRATCH];

test("no filter keeps everything, Scratch included", () => {
  expect(ids(applyFilter(canvases, NO_FILTER))).toEqual(["a", "b", "c", "d"]);
  expect(isFiltering(NO_FILTER)).toBe(false);
});

test("a person keeps the canvases they started", () => {
  expect(ids(applyFilter(canvases, { person: "sam", projects: null }))).toEqual(["a", "c", "d"]);
});

test("unchecking a repo hides only that repo's canvases; Scratch's stay", () => {
  const filter = toggleProject(NO_FILTER, FERNWOOD, ALL);
  expect(filter.projects).toEqual([LENNY, SCRATCH]);
  expect(isFiltering(filter)).toBe(true);
  expect(ids(applyFilter(canvases, filter))).toEqual(["c", "d"]);
  expect(ids(applyFilter(canvases, { person: "sam", projects: [FERNWOOD] }))).toEqual(["a"]);
});

test("Scratch is unchecked like a repo", () => {
  const filter = toggleProject(NO_FILTER, SCRATCH, ALL);
  expect(ids(applyFilter(canvases, filter))).toEqual(["a", "b", "c"]);
});

test("a repo named like Scratch is still a repo", () => {
  expect(repoKey(repo(SCRATCH))).not.toBe(SCRATCH);
});

test("checking every project again, or unchecking the last, is no filter", () => {
  const one = toggleProject(toggleProject(NO_FILTER, FERNWOOD, ALL), SCRATCH, ALL);
  expect(one.projects).toEqual([LENNY]);
  expect(toggleProject(one, LENNY, ALL).projects).toBeNull();
  expect(toggleProject(toggleProject(one, FERNWOOD, ALL), SCRATCH, ALL).projects).toBeNull();
});

test("project counts: repos with canvases, most first, then Scratch", () => {
  expect(projectCounts(canvases).map((p) => [p.repo?.name ?? p.key, p.count])).toEqual([
    ["fernwood", 2],
    ["lenny", 1],
    [SCRATCH, 1],
  ]);
});

test("a filter from storage is read field by field; anything else is none", () => {
  expect(readFilter({ person: "sam", projects: [FERNWOOD, 2] })).toEqual({
    person: "sam",
    projects: [FERNWOOD],
  });
  expect(readFilter({ person: 1, projects: "all" })).toEqual(NO_FILTER);
  expect(readFilter(null)).toEqual(NO_FILTER);
  expect(readFilter("filter")).toEqual(NO_FILTER);
});

test("a project no canvas is in any more is dropped, so it never hides everything", () => {
  // Only a repo gone: nothing left to keep, so no project filter at all.
  const gone = { person: null, projects: ["repo:gone"] };
  expect(pruneFilter(gone, ALL, null)).toEqual(NO_FILTER);
  expect(ids(applyFilter(canvases, pruneFilter(gone, ALL, null)))).toEqual(["a", "b", "c", "d"]);
  // A repo gone beside one still here: the one here stays checked.
  expect(pruneFilter({ person: null, projects: [LENNY, "repo:gone"] }, ALL, null)).toEqual({
    person: null,
    projects: [LENNY],
  });
  // What's left checks every project there is: no project filter.
  const both = { person: null, projects: [FERNWOOD, LENNY] };
  expect(pruneFilter(both, [FERNWOOD, LENNY], null)).toEqual(NO_FILTER);
});

test("a person no longer offered is everyone; not known yet, they stay", () => {
  const sam = { person: "sam", projects: null };
  expect(pruneFilter(sam, ALL, ["maya"])).toEqual(NO_FILTER);
  expect(pruneFilter(sam, ALL, null)).toBe(sam);
  expect(pruneFilter(sam, ALL, ["sam", "maya"])).toBe(sam);
});

test("a filter with nothing stale is the same filter", () => {
  const filter = { person: "sam", projects: [FERNWOOD, SCRATCH] };
  expect(pruneFilter(filter, ALL, ["sam"])).toBe(filter);
});

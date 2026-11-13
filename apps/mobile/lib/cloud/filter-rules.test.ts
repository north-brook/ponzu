import { expect, test } from "bun:test";
import { NO_FILTER } from "@ponzu/client/model";
import { filterKey, pruneFilter, readFilter, readFilters, withFilter } from "./filter-rules";
import { keysToClear } from "./sign-out";

test("each person's filters are kept apart, and signing out takes them", () => {
  expect(filterKey("usr_maya")).toBe("ponzu.filter.usr_maya");
  expect(keysToClear([filterKey("usr_maya")])).toEqual([filterKey("usr_maya")]);
});

test("a filter for each workspace; no filter is kept as nothing", () => {
  const sam = { person: "usr_sam", projects: null };
  const one = withFilter({}, "ws_1", sam);
  expect(one).toEqual({ ws_1: sam });
  const two = withFilter(one, "ws_2", { person: null, projects: ["scratch"] });
  expect(Object.keys(two)).toEqual(["ws_1", "ws_2"]);
  expect(withFilter(two, "ws_1", NO_FILTER)).toEqual({
    ws_2: { person: null, projects: ["scratch"] },
  });
  // The one given is left as it was.
  expect(one).toEqual({ ws_1: sam });
});

test("what storage holds comes back; anything else counts as no filter", () => {
  const kept = { ws_1: { person: "usr_sam", projects: ["repo:repo_1"] } };
  expect(readFilters(JSON.stringify(kept))).toEqual(kept);
  expect(
    readFilters(JSON.stringify({ ws_1: { person: 3, projects: ["repo:a", 2] }, ws_2: "x" })),
  ).toEqual({ ws_1: { person: null, projects: ["repo:a"] } });
  expect(readFilters("{not json")).toEqual({});
  expect(readFilters(null)).toEqual({});
  expect(readFilters("[]")).toEqual({});
});

test("a filter from storage is read field by field; anything else is none", () => {
  expect(readFilter({ person: "sam", projects: ["repo:1", 2] })).toEqual({
    person: "sam",
    projects: ["repo:1"],
  });
  expect(readFilter({ person: 1, projects: "all" })).toEqual(NO_FILTER);
  expect(readFilter(null)).toEqual(NO_FILTER);
  expect(readFilter("filter")).toEqual(NO_FILTER);
});

test("a project no canvas is in any more is dropped, so it never hides everything", () => {
  const all = ["repo:1", "repo:2", "scratch"];
  expect(pruneFilter({ person: null, projects: ["repo:gone"] }, all, null)).toEqual(NO_FILTER);
  expect(pruneFilter({ person: null, projects: ["repo:2", "repo:gone"] }, all, null)).toEqual({
    person: null,
    projects: ["repo:2"],
  });
  // What's left checks every project there is: no project filter.
  expect(
    pruneFilter({ person: null, projects: ["repo:1", "repo:2"] }, ["repo:1", "repo:2"], null),
  ).toEqual(NO_FILTER);
});

test("a person no longer offered is everyone; not known yet, they stay", () => {
  const sam = { person: "sam", projects: null };
  expect(pruneFilter(sam, ["scratch"], ["maya"])).toEqual(NO_FILTER);
  expect(pruneFilter(sam, ["scratch"], null)).toBe(sam);
  expect(pruneFilter(sam, ["scratch"], ["sam", "maya"])).toBe(sam);
});

import { expect, test } from "bun:test";
import { NO_FILTER } from "@ponzu/client/model";
import { filterKey, readFilters, withFilter } from "./filter-rules";
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

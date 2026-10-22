import { expect, test } from "bun:test";
import { parseOpenTarget, retarget, targetPath } from "./github.ts";

test("ponzu open takes the viewer's own path", () => {
  expect(parseOpenTarget("north-brook/ponzu/examples/kettle.design")).toEqual({
    kind: "design",
    owner: "north-brook",
    repo: "ponzu",
    path: "examples/kettle.design",
    extra: false,
  });
  expect(parseOpenTarget("o/r@feature%2Fx/My%20Designs/a.design")).toMatchObject({
    ref: "feature/x",
    path: "My Designs/a.design",
  });
  expect(parseOpenTarget("o/r")).toEqual({ kind: "repo", owner: "o", repo: "r", prefix: "" });
});

test("ponzu open takes a ponzu.design or github.com link", () => {
  expect(parseOpenTarget("https://ponzu.design/gh/o/r@v1/d/a.design")).toMatchObject({
    kind: "design",
    ref: "v1",
    path: "d/a.design",
  });
  expect(parseOpenTarget("ponzu.design/gh/o/r/a.design")).toMatchObject({ path: "a.design" });
  expect(parseOpenTarget("https://github.com/o/r")).toEqual({
    kind: "repo",
    owner: "o",
    repo: "r",
    prefix: "",
  });
  expect(parseOpenTarget("https://github.com/o/r.git")).toMatchObject({ repo: "r" });
  expect(parseOpenTarget("https://github.com/o/r/tree/main/examples/kettle.design")).toEqual({
    kind: "design",
    owner: "o",
    repo: "r",
    ref: "main",
    path: "examples/kettle.design",
    extra: false,
    refTail: ["examples", "kettle.design"],
  });
  // A file inside the design opens the design.
  expect(
    parseOpenTarget("https://github.com/o/r/blob/main/a.design/pages/home/x.html"),
  ).toMatchObject({ path: "a.design", extra: true });
});

test("ponzu open refuses what isn't a GitHub path", () => {
  expect(parseOpenTarget("kettle.design")).toBeNull();
  expect(parseOpenTarget("https://example.com/o/r")).toBeNull();
  expect(parseOpenTarget("https://ponzu.design/download")).toBeNull();
  expect(parseOpenTarget("https://github.com/o/r/pulls")).toBeNull();
  expect(parseOpenTarget("../r/a.design")).toBeNull();
  expect(parseOpenTarget("o/r@a..b/a.design")).toBeNull();
});

test("a target's path round-trips", () => {
  const path = targetPath({ owner: "o", repo: "r", ref: "feature/x" }, "My Designs/a.design");
  expect(path).toBe("o/r@feature%2Fx/My%20Designs/a.design");
  expect(parseOpenTarget(path)).toMatchObject({ ref: "feature/x", path: "My Designs/a.design" });
});

test("a target's path is safe to paste into a shell", () => {
  // Refs and folders on GitHub can hold ; $ ` ' ( ) and more: none survive unencoded.
  const path = targetPath(
    { owner: "o", repo: "r", ref: "x;curl$IFS`id`|sh" },
    "it's (v2);id.design",
  );
  expect(path).toMatch(/^[A-Za-z0-9_.~%@/-]+$/);
  expect(parseOpenTarget(path)).toMatchObject({
    ref: "x;curl$IFS`id`|sh",
    path: "it's (v2);id.design",
  });
});

test("a github.com link's ref can run into its path", () => {
  const link = parseOpenTarget("https://github.com/o/r/tree/feature/x/a.design")!;
  // Read at face value first: branch "feature", design "x/a.design".
  expect(link).toMatchObject({ ref: "feature", path: "x/a.design" });
  // Until the repo says branch "feature/x" exists.
  expect(retarget(link, 1)).toMatchObject({ kind: "design", ref: "feature/x", path: "a.design" });
  // Running into the design's own name leaves a folder of the repo to list.
  expect(retarget(link, 2)).toMatchObject({ kind: "repo", ref: "feature/x/a.design", prefix: "" });
  expect(retarget(link, 3)).toBeNull();
  // A ponzu.design link encodes the slash, so its ref never runs on.
  expect(parseOpenTarget("ponzu.design/gh/o/r@feature%2Fx/a.design")?.refTail).toBeUndefined();
});

import { expect, test } from "bun:test";
import { parseOpenTarget, targetPath } from "./github.ts";

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

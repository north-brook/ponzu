import { expect, test } from "bun:test";
import {
  bagFiles,
  findDesigns,
  folderName,
  parseTarget,
  type TreeEntry,
  viewerPath,
} from "./target.ts";

test("a path ending in .design is a design", () => {
  expect(parseTarget(["north-brook", "ponzu", "examples", "kettle.design"])).toEqual({
    kind: "design",
    owner: "north-brook",
    repo: "ponzu",
    path: "examples/kettle.design",
    extra: false,
  });
  // Anything after the design is dropped, and the page redirects to the design.
  expect(parseTarget(["o", "r", "a.design", "pages", "x.html"])).toMatchObject({
    kind: "design",
    path: "a.design",
    extra: true,
  });
});

test("a repo, or a folder in it, lists its designs", () => {
  expect(parseTarget(["o", "r"])).toEqual({ kind: "repo", owner: "o", repo: "r", prefix: "" });
  expect(parseTarget(["o", "r", "design"])).toMatchObject({ kind: "repo", prefix: "design" });
  // Just ".design" is a folder name, not a design.
  expect(parseTarget(["o", "r", ".design"])).toMatchObject({ kind: "repo" });
});

test("a ref rides on the repo after an @", () => {
  expect(parseTarget(["o", "r@v1.2.0", "a.design"])).toMatchObject({ ref: "v1.2.0" });
  // Next decodes each segment, so feature%2Fx arrives as feature/x.
  expect(parseTarget(["o", "r@feature/x", "a.design"])).toMatchObject({ ref: "feature/x" });
  // The page gets the same segments still encoded.
  expect(parseTarget(["o", "r%40feature%2Fx", "My%20Designs", "a.design"])).toMatchObject({
    repo: "r",
    ref: "feature/x",
    path: "My Designs/a.design",
  });
  expect(parseTarget(["o", "r@", "a.design"])).toBeNull();
  expect(parseTarget(["o", "r@a..b"])).toBeNull();
  expect(parseTarget(["o", "r@a b"])).toBeNull();
});

test("names and paths that can't be on GitHub are refused", () => {
  expect(parseTarget(["o"])).toBeNull();
  expect(parseTarget(["o w", "r"])).toBeNull();
  expect(parseTarget(["o", ".."])).toBeNull();
  expect(parseTarget(["o", "r", "..", "a.design"])).toBeNull();
  expect(parseTarget(["o", "r", "a/b.design"])).toBeNull();
});

test("viewer paths round-trip, ref and all", () => {
  expect(viewerPath({ owner: "o", repo: "r" }, "examples/kettle.design")).toBe(
    "/gh/o/r/examples/kettle.design",
  );
  expect(viewerPath({ owner: "o", repo: "r", ref: "feature/x" }, "My Designs/a.design")).toBe(
    "/gh/o/r@feature%2Fx/My%20Designs/a.design",
  );
  const back = viewerPath({ owner: "o", repo: "r", ref: "feature/x" }, "d/a.design")
    .split("/")
    .slice(2)
    .map(decodeURIComponent);
  expect(parseTarget(back)).toMatchObject({ ref: "feature/x", path: "d/a.design" });
  expect(folderName("design/Kettle.design")).toBe("Kettle");
});

const tree: TreeEntry[] = [
  { path: "README.md", type: "blob", size: 10 },
  { path: "design", type: "tree" },
  { path: "design/app.design", type: "tree" },
  { path: "design/app.design/design.json", type: "blob", size: 100 },
  { path: "design/app.design/pages/home/a.html", type: "blob", size: 100 },
  { path: "design/app.design/pages/home/b.html", type: "blob", size: 100 },
  { path: "design/app.design/pages/brand/logo.html", type: "blob", size: 100 },
  { path: "design/app.design/assets/logo.png", type: "blob", size: 100 },
  { path: "design/app.design/old.design", type: "tree" },
  { path: "design/app.design/old.design/pages/x/y.html", type: "blob", size: 100 },
  { path: "brand.design", type: "tree" },
  { path: "brand.design/pages/p/q.html", type: "blob", size: 100 },
  { path: "notes.design.md", type: "blob", size: 100 },
];

test("finds every design in a tree, counting boards without reading them", () => {
  expect(findDesigns(tree)).toEqual([
    { path: "brand.design", artboards: 1, pages: 1, assets: 0, meta: false },
    // The design nested inside app.design belongs to it.
    { path: "design/app.design", artboards: 3, pages: 2, assets: 1, meta: true },
  ]);
  expect(findDesigns(tree, "design").map((d) => d.path)).toEqual(["design/app.design"]);
  expect(findDesigns(tree, "nowhere")).toEqual([]);
});

test("reads only the files the format defines", () => {
  const own: TreeEntry[] = [
    { path: "design.json", type: "blob" },
    { path: "tokens.css", type: "blob" },
    { path: "comments.json", type: "blob" },
    { path: "notes/brief.md", type: "blob" },
    { path: "notes", type: "tree" },
    { path: "pages/home/a.html", type: "blob" },
    { path: "pages/home/deep/b.html", type: "blob" },
    { path: "assets/logo.png", type: "blob" },
    { path: "exports/a.png", type: "blob" },
  ];
  expect(bagFiles(own).map((e) => e.path)).toEqual([
    "design.json",
    "tokens.css",
    "comments.json",
    "notes/brief.md",
    "pages/home/a.html",
  ]);
});

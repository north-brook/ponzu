import { expect, test } from "bun:test";
import type { Catalog, CatalogFile } from "@ponzu/core";
import { mergeCatalogs, type PhoneFile, projects, shortAgo, whereLine } from "./files";
import { mark, search } from "./search";

const file = (over: Partial<CatalogFile> = {}): CatalogFile => ({
  id: "local:/a/kettle.design",
  key: "/a/kettle.design",
  name: "Kettle",
  machine: "local",
  base: "",
  modified: 1000,
  preview: "/api/preview?file=k",
  pages: [{ id: "pg_1", name: "Brand" }],
  artboards: [{ id: "ab_1", name: "Logo", page: "pg_1", thumb: "/api/thumb?file=k&artboard=ab_1" }],
  ...over,
});
const catalog = (files: CatalogFile[]): Catalog => ({ machines: [], files, agents: [] });
const macs = [
  { id: "mbp", name: "MacBook", kind: "laptop" as const, base: "http://mbp:7777" },
  { id: "spare", name: "spare", kind: "desktop" as const, base: "http://spare:7777" },
];

test("every Mac's designs in one list, newest first, with absolute URLs and dimmed when asleep", () => {
  const merged = mergeCatalogs(
    macs,
    {
      mbp: { catalog: catalog([file({ modified: 10 })]), at: 0 },
      spare: {
        catalog: catalog([
          file({ id: "local:/b/weft.design", key: "/b/weft.design", name: "Weft", modified: 20 }),
        ]),
        at: 0,
      },
    },
    (id) => id === "mbp",
  );
  expect(merged.map((f) => [f.name, f.macName, f.stale])).toEqual([
    ["Weft", "spare", true],
    ["Kettle", "MacBook", false],
  ]);
  expect(merged[1]!.preview).toBe("http://mbp:7777/api/preview?file=k");
  expect(merged[1]!.artboards[0]!.thumb).toBe("http://mbp:7777/api/thumb?file=k&artboard=ab_1");
  expect(merged[1]!.id).toBe("mbp:/a/kettle.design");
});

test("project chips: biggest first, then the designs in no project", () => {
  const files = [
    file({ git: { root: "/r", projectName: "ponzu" } }),
    file({ git: { root: "/r", projectName: "ponzu" } }),
    file({ git: { root: "/s", projectName: "os" } }),
    file(),
  ] as PhoneFile[];
  expect(projects(files)).toEqual([
    { name: "ponzu", count: 2 },
    { name: "os", count: 1 },
    { name: null, count: 1 },
  ]);
});

test("a card's line: the project and branch, or the folder outside git", () => {
  expect(
    whereLine(
      file({
        git: { root: "/w/t3", branch: "fix/x", project: "north-brook/ponzu", projectName: "ponzu" },
      }) as PhoneFile,
    ),
  ).toMatchObject({ project: "ponzu", branch: "fix/x" });
  // A repository with no remote is named by its folder.
  expect(
    whereLine(file({ git: { root: "/Users/b/git/seekle", branch: "main" } }) as PhoneFile),
  ).toMatchObject({ project: "seekle", branch: "main" });
  expect(whereLine(file({ key: "/Users/b/examples/kettle.design" }) as PhoneFile)).toEqual({
    project: null,
    branch: null,
    folder: "examples",
  });
});

test("times read as the desktop's cards do", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  expect(shortAgo(now - 20_000, now)).toBe("now");
  expect(shortAgo(now - 4 * 60_000, now)).toBe("4m");
  expect(shortAgo(now - 2 * 3_600_000, now)).toBe("2h");
  expect(shortAgo(now - 86_400_000, now)).toBe("1d");
  expect(shortAgo(Date.UTC(2026, 9, 14, 12), now)).toBe("Oct 14");
});

test("search finds files and frames by every word, and marks what matched", () => {
  const files = mergeCatalogs(
    macs.slice(0, 1),
    {
      mbp: {
        catalog: catalog([
          file({ name: "Ponzu brand", key: "/p.design", id: "local:/p.design" }),
          file({ pages: [{ id: "pg_1", name: "Brand" }] }),
        ]),
        at: 0,
      },
    },
    () => true,
  );
  const r = search(files, "brand");
  expect(r.files.map((h) => h.file.name)).toEqual(["Ponzu brand"]);
  expect(r.frames.map((h) => `${h.artboard.name} · ${h.pageName} · ${h.file.name}`).sort()).toEqual(
    ["Logo · Brand · Kettle", "Logo · Brand · Ponzu brand"],
  );
  expect(search(files, "logo kettle").frames).toHaveLength(1);
  expect(search(files, "  ").files).toHaveLength(0);
  expect(mark("Ponzu brand", ["brand"])).toEqual([
    { text: "Ponzu ", hit: false },
    { text: "brand", hit: true },
  ]);
  expect(mark("Café", ["cafe"])).toEqual([{ text: "Café", hit: true }]);
});

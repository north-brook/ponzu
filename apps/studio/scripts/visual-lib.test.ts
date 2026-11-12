/*
 * The site's product shots: SITE_SHOTS names compositions that exist, each one's pictures are
 * committed in both themes at the scale the site serves, and the people in the gallery they are
 * drawn from are fictional (no real address can reach a public picture).
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { heroBoards, teamHeroBoards } from "../src/cloud/gallery/canvas-fixtures.ts";
import { COMPOSITIONS } from "../src/cloud/gallery/compositions.ts";
import * as f from "../src/cloud/gallery/fixtures.ts";
import {
  REFERENCES,
  SITE_BOARDS,
  SITE_PRODUCT,
  SITE_SCALE,
  SITE_SHOTS,
  STUDIO,
} from "./visual-lib.ts";

test("the shots drawn with boards are site shots, and their boards carry their pins", () => {
  for (const id of SITE_BOARDS) expect(SITE_SHOTS as readonly string[]).toContain(id);
  for (const doc of [heroBoards, teamHeroBoards]) {
    const boards = new Set(doc.pages.flatMap((p) => p.artboards.map((a) => a.id)));
    expect(boards.size).toBeGreaterThanOrEqual(4);
    for (const thread of doc.threads) expect(boards.has(thread.artboardId!)).toBe(true);
    // Every board has something drawn in it.
    for (const board of doc.pages.flatMap((p) => p.artboards))
      expect(board.root.children.length).toBeGreaterThan(0);
  }
  expect(teamHeroBoards.threads.length).toBe(3);
});

test("the workspaces and repo owners the shots can show are the invented ones", () => {
  expect(f.workspaces.map((w) => [w.name, w.login])).toEqual([
    ["Thistlewick", "thistlewick"],
    ["Quillmoor", "quillmoor"],
    ["Ada Park", "adapark"],
  ]);
  expect(f.brambleSchool.name).toBe("Bramble School");
  const owners = new Set(
    [...f.manyRepos, ...f.brambleRepos, ...f.personalRepos, ...f.oneRepo].map((r) => r.owner),
  );
  expect([...owners].sort()).toEqual(["adapark", "brambleschool", "thistlewick"]);
});

test("SITE_SHOTS names existing compositions, once each", () => {
  const ids = new Set(COMPOSITIONS.map((c) => c.id));
  for (const id of SITE_SHOTS) expect(ids.has(id)).toBe(true);
  expect(new Set(SITE_SHOTS).size).toBe(SITE_SHOTS.length);
});

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("every shot is committed in light and dark, at twice its composition's size", () => {
  const committed = readdirSync(SITE_PRODUCT)
    .filter((name) => name.endsWith(".png"))
    .sort();
  const expected = SITE_SHOTS.flatMap((id) => [`${id}-dark.png`, `${id}-light.png`]).sort();
  expect(committed).toEqual(expected);
  for (const id of SITE_SHOTS) {
    const c = COMPOSITIONS.find((c) => c.id === id)!;
    for (const theme of ["light", "dark"]) {
      const size = pngSize(readFileSync(join(SITE_PRODUCT, `${id}-${theme}.png`)));
      expect(size).toEqual({ width: c.width * SITE_SCALE, height: c.height * SITE_SCALE });
    }
  }
});

test("the gallery's people have only example addresses", () => {
  const gallery = join(STUDIO, "src/cloud/gallery");
  const sources = [
    ...readdirSync(gallery)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => join(gallery, name)),
    ...readdirSync(REFERENCES)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => join(REFERENCES, name)),
  ];
  const addresses = new Set<string>();
  for (const file of sources) {
    for (const match of readFileSync(file, "utf8").matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) {
      addresses.add(match[0]);
    }
  }
  for (const address of addresses) expect(address).toMatch(/@example\.(com|org)$/);
  // The signed-in person the shots show is the fictional one.
  expect(readFileSync(join(gallery, "fixtures.ts"), "utf8")).toContain('name: "Ada Park"');
});

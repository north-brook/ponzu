import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerOf } from "./installer.ts";

let dir: string;
/** Resources with a feed, and with a feed and the .deb's package type. */
let feed: string;
let deb: string;
let unpacked: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-installer-"));
  [feed, deb, unpacked] = ["feed", "deb", "unpacked"].map((d) => join(dir, d)) as [
    string,
    string,
    string,
  ];
  for (const d of [feed, deb, unpacked]) await mkdir(d);
  for (const d of [feed, deb]) await writeFile(join(d, "app-update.yml"), "provider: github\n");
  await writeFile(join(deb, "package-type"), "deb\n");
});

afterAll(() => rm(dir, { recursive: true, force: true }));

test("each platform's installer, from a build with a feed", () => {
  expect(installerOf(feed, "darwin", {})).toBe("squirrel");
  expect(installerOf(feed, "win32", {})).toBe("nsis");
  expect(installerOf(deb, "linux", {})).toBe("deb");
  expect(installerOf(feed, "linux", { APPIMAGE: "/home/a/Ponzu-x64.AppImage" })).toBe("appimage");
});

test("an AppImage whose resources the .deb's build marked is still an AppImage", () => {
  expect(installerOf(deb, "linux", { APPIMAGE: "/home/a/Ponzu-x64.AppImage" })).toBe("appimage");
});

test("a build that can't update itself has none", () => {
  for (const os of ["darwin", "win32", "linux"] as const)
    expect(installerOf(unpacked, os, {})).toBe(null);
  // Linux from an unpacked folder: a feed, but neither an AppImage nor a package.
  expect(installerOf(feed, "linux", {})).toBe(null);
  expect(installerOf(feed, "freebsd", {})).toBe(null);
});

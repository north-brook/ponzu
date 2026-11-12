import { expect, test } from "bun:test";
import { changelogProblems, type File, problems } from "./release-assets";

const file = (size: number, sha512 = `sha-${size}`): File => ({ size, sha512 });

const feed = (version: string, path: string, ...files: [string, number][]) =>
  [
    `version: ${version}`,
    "files:",
    ...files.flatMap(([url, size]) => [
      `  - url: ${url}`,
      `    sha512: sha-${size}`,
      `    size: ${size}`,
    ]),
    `path: ${path}`,
    `sha512: sha-${files[0]?.[1]}`,
    "releaseDate: '2026-10-28T12:00:00.000Z'",
  ].join("\n");

/** A whole release of 1.66.0, as the three platforms' jobs leave it. */
const release = () => ({
  feeds: {
    "latest-mac.yml": feed(
      "1.66.0",
      "Ponzu-1.66.0-arm64-mac.zip",
      ["Ponzu-1.66.0-arm64-mac.zip", 30],
      ["Ponzu-arm64.dmg", 31],
    ),
    "latest.yml": feed("1.66.0", "Ponzu-x64.exe", ["Ponzu-x64.exe", 20]),
    "latest-linux.yml": feed(
      "1.66.0",
      "Ponzu-x64.AppImage",
      ["Ponzu-x64.AppImage", 10],
      ["Ponzu-x64.deb", 11],
    ),
  } as Record<string, string>,
  files: new Map<string, File>([
    ["Ponzu-1.66.0-arm64-mac.zip", file(30)],
    ["Ponzu-arm64.dmg", file(31)],
    ["Ponzu-x64.exe", file(20)],
    ["Ponzu-x64.AppImage", file(10)],
    ["Ponzu-x64.deb", file(11)],
    ["release-notes.json", file(1)],
  ]),
});

const all = ["mac", "windows", "linux"] as const;

test("a release with every platform's feed, files and downloads can be published", () => {
  const { feeds, files } = release();
  for (const name of Object.keys(feeds)) files.set(name, file(1));
  expect(problems("1.66.0", [...all], feeds, files)).toEqual([]);
});

test("a platform that didn't build holds the release back", () => {
  const { feeds, files } = release();
  delete feeds["latest.yml"];
  files.delete("Ponzu-x64.exe");
  expect(problems("1.66.0", [...all], feeds, files)).toEqual([
    "Ponzu-x64.exe is missing",
    "latest.yml is missing",
  ]);
  // A dry run that built only the others checks only theirs.
  expect(problems("1.66.0", ["mac", "linux"], feeds, files)).toEqual([]);
});

test("a file a feed names must be there, and be the file it describes", () => {
  const { feeds, files } = release();
  files.delete("Ponzu-x64.deb");
  files.set("Ponzu-x64.AppImage", file(10, "other"));
  expect(problems("1.66.0", ["linux"], feeds, files)).toEqual([
    "Ponzu-x64.deb is missing",
    "Ponzu-x64.AppImage isn't the file latest-linux.yml describes",
    "Ponzu-x64.deb, in latest-linux.yml, is missing",
  ]);
});

test("a feed for another version, or none at all, holds it back", () => {
  const { feeds, files } = release();
  feeds["latest.yml"] = feed("1.65.0", "Ponzu-x64.exe", ["Ponzu-x64.exe", 20]);
  expect(problems("1.66.0", ["windows"], feeds, files)).toEqual([
    "latest.yml is for 1.65.0, not 1.66.0",
  ]);
  feeds["latest.yml"] = "version: 1.66.0\n";
  expect(problems("1.66.0", ["windows"], feeds, files)).toEqual([
    "latest.yml names no files",
    "Ponzu-x64.exe isn't in latest.yml, so nothing installed from it updates",
  ]);
});

test("the release notes go with every release", () => {
  const { feeds, files } = release();
  files.delete("release-notes.json");
  expect(problems("1.66.0", ["windows"], feeds, files)).toEqual(["release-notes.json is missing"]);
});

test("a download its feed doesn't name holds it back: nothing installed from it would update", () => {
  const { feeds, files } = release();
  feeds["latest-linux.yml"] = feed("1.66.0", "Ponzu-x64.AppImage", ["Ponzu-x64.AppImage", 10]);
  expect(problems("1.66.0", ["linux"], feeds, files)).toEqual([
    "Ponzu-x64.deb isn't in latest-linux.yml, so nothing installed from it updates",
  ]);
});

test("a feed's path, which older updaters read, must be one of the files it checks", () => {
  const { feeds, files } = release();
  feeds["latest.yml"] = feed("1.66.0", "Ponzu-Setup.exe", ["Ponzu-x64.exe", 20]);
  files.set("Ponzu-Setup.exe", file(20, "other"));
  expect(problems("1.66.0", ["windows"], feeds, files)).toEqual([
    "latest.yml's path, Ponzu-Setup.exe, isn't one of its files",
  ]);
});

const CHANGELOG = JSON.stringify({
  mac: [{ version: "2.1.0", date: "2026-11-20T18:15:00-05:00", notes: ["Pins stay put."] }],
  iphone: [],
});

test("a release passes with or without the site's changelog.json", () => {
  const { feeds, files } = release();
  // Built before the publish job wrote one.
  expect(problems("1.66.0", ["windows"], feeds, files)).toEqual([]);
  files.set("changelog.json", file(CHANGELOG.length));
  expect(problems("1.66.0", ["windows"], feeds, files, CHANGELOG)).toEqual([]);
  // A shallow run's file says it's incomplete, and still has both lists.
  const incomplete = JSON.stringify({ mac: [], iphone: [], incomplete: true });
  expect(problems("1.66.0", ["windows"], feeds, files, incomplete)).toEqual([]);
});

test("a changelog.json the site couldn't read holds the release back", () => {
  const { feeds, files } = release();
  expect(problems("1.66.0", ["windows"], feeds, files, "{")).toEqual(["changelog.json isn't JSON"]);
  expect(changelogProblems("[]")).toEqual([
    "changelog.json has no mac list",
    "changelog.json has no iphone list",
  ]);
  expect(changelogProblems("null")).toEqual(["changelog.json isn't an object"]);
  expect(
    changelogProblems(
      JSON.stringify({
        mac: [{ version: "v2.1.0", date: "2026-11-20", notes: [] }],
        iphone: [{ version: "1.0.0", date: "someday", notes: ["ok"] }, { version: "1.0.1" }],
      }),
    ),
  ).toEqual([
    "changelog.json's mac release 1 isn't a version, date and notes",
    "changelog.json's iphone release 1 isn't a version, date and notes",
    "changelog.json's iphone release 2 isn't a version, date and notes",
  ]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneTarget, type Git, openFromGitHub, parseOpenUrl } from "./clone.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ponzu-clones-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A git that records its calls and "clones" by making the design's folder. */
function fakeGit(paths: string[], code = 0) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const git: Git = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "clone" && code === 0) {
      const dest = args.at(-1)!;
      await mkdir(join(dest, ".git"), { recursive: true });
      for (const p of paths) await mkdir(join(dest, p), { recursive: true });
    }
    return code;
  };
  return { git, calls };
}

test("clones the repo into owner/repo and serves the design", async () => {
  const { git, calls } = fakeGit(["examples/kettle.design"]);
  const opened = await openFromGitHub("north-brook/ponzu/examples/kettle.design", git, root);
  const clone = join(root, "north-brook", "ponzu");
  expect(opened.path).toBe(join(clone, "examples/kettle.design"));
  expect(calls).toEqual([
    { args: ["clone", "--", "https://github.com/north-brook/ponzu.git", clone], cwd: undefined },
  ]);
});

test("reuses a clone, fetches, and checks out the ref", async () => {
  const clone = join(root, "o", "r");
  await mkdir(join(clone, ".git"), { recursive: true });
  await mkdir(join(clone, "a.design"), { recursive: true });
  const { git, calls } = fakeGit([]);
  const opened = await openFromGitHub(
    "https://ponzu.design/gh/o/r@feature%2Fx/a.design",
    git,
    root,
  );
  expect(opened.target.ref).toBe("feature/x");
  expect(calls.map((c) => c.args)).toEqual([
    ["fetch", "--quiet", "origin"],
    ["checkout", "--quiet", "feature/x", "--"],
    ["merge", "--quiet", "--ff-only", "@{upstream}"],
  ]);
  expect(calls.every((c) => c.cwd === clone)).toBe(true);
});

test("a repo link serves every design in it", async () => {
  const { git } = fakeGit([]);
  const opened = await openFromGitHub("https://github.com/o/r", git, root);
  expect(opened.path).toBe(join(root, "o", "r"));
});

test("says why it can't", async () => {
  const { git, calls } = fakeGit([]);
  await expect(openFromGitHub(undefined, git, root)).rejects.toThrow("takes a design on GitHub");
  await expect(openFromGitHub("kettle.design", git, root)).rejects.toThrow('not "kettle.design"');
  // A ref git would read as an option never reaches it.
  await expect(openFromGitHub("o/r@--upload-pack=x/a.design", git, root)).rejects.toThrow();
  expect(calls).toEqual([]);
  const failing = fakeGit([], 128);
  await expect(openFromGitHub("o/r/a.design", failing.git, root)).rejects.toThrow("Couldn't clone");
  // Cloned, but the design isn't there.
  const empty = fakeGit([]);
  await expect(openFromGitHub("o/r/missing.design", empty.git, root)).rejects.toThrow("isn't in");
});

test("reads the Mac app's ponzu://open links", () => {
  expect(parseOpenUrl("ponzu://open?repo=north-brook/ponzu&path=examples/kettle.design")).toEqual({
    kind: "design",
    owner: "north-brook",
    repo: "ponzu",
    path: "examples/kettle.design",
    extra: false,
  });
  expect(
    parseOpenUrl("ponzu://open?repo=o/r&ref=feature%2Fx&path=My%20Designs%2Fa.design"),
  ).toMatchObject({ ref: "feature/x", path: "My Designs/a.design" });
  // A literal % in a name is taken as written, not decoded twice.
  expect(parseOpenUrl("ponzu://open?repo=o/r&path=100%2525.design")).toMatchObject({
    path: "100%25.design",
  });
  expect(parseOpenUrl("ponzu:open?repo=o/r&path=a.design")).toMatchObject({ path: "a.design" });
});

test("refuses ponzu:// links that could reach outside the clone or into git's options", () => {
  const bad = [
    "https://open?repo=o/r&path=a.design",
    "ponzu://serve?repo=o/r&path=a.design",
    "ponzu://open?repo=o&path=a.design",
    "ponzu://open?repo=o/r/x&path=a.design",
    "ponzu://open?repo=../r&path=a.design",
    "ponzu://open?repo=o/..&path=a.design",
    "ponzu://open?repo=o/r%20x&path=a.design",
    "ponzu://open?repo=o/r&path=a",
    "ponzu://open?repo=o/r&path=../../a.design",
    "ponzu://open?repo=o/r&path=/etc/a.design",
    "ponzu://open?repo=o/r&path=x/./a.design",
    "ponzu://open?repo=o/r&ref=--upload-pack%3Dtouch%20x&path=a.design",
    "ponzu://open?repo=o/r&ref=a..b&path=a.design",
    "ponzu://open?repo=o/r&ref=a%20b&path=a.design",
    "ponzu://open?repo=o/r&path=a.design/pages/x.html",
    "not a url",
  ];
  for (const url of bad) expect(parseOpenUrl(url), url).toBeNull();
});

test("a design that links out of its clone isn't opened", async () => {
  const clone = join(root, "o", "r");
  await mkdir(join(clone, ".git"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "ponzu-outside-"));
  await symlink(outside, join(clone, "a.design"));
  const { git } = fakeGit([]);
  const target = parseOpenUrl("ponzu://open?repo=o/r&path=a.design")!;
  await expect(cloneTarget(target, git, root)).rejects.toThrow("points outside");
  await rm(outside, { recursive: true, force: true });
});

test("a github.com link to a branch with a slash opens the design on that branch", async () => {
  const clone = join(root, "o", "r");
  await mkdir(join(clone, ".git"), { recursive: true });
  await mkdir(join(clone, "a.design"), { recursive: true });
  const calls: string[][] = [];
  const git: Git = async (args) => {
    calls.push(args);
    // The repo has branch feature/x, and no branch or tag named feature.
    if (args[0] === "rev-parse")
      return args.at(-1) === "refs/remotes/origin/feature/x^{commit}" ? 0 : 1;
    return 0;
  };
  const opened = await openFromGitHub("https://github.com/o/r/tree/feature/x/a.design", git, root);
  expect(opened.target).toMatchObject({ ref: "feature/x", path: "a.design" });
  expect(calls).toContainEqual(["checkout", "--quiet", "feature/x", "--"]);
});

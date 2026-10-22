import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Git, openFromGitHub } from "./open.ts";

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

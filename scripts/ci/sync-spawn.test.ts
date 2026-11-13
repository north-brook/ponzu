/**
 * No test calls a synchronous spawn. Under `bun test --parallel`, Bun 1.4.2's spawnSync (and
 * node's execFileSync, execSync and spawnSync, which take the same path) can lose the child's
 * exit when a GC runs during the wait (oven-sh/bun#47257, fixed upstream in Bun 1.4.4). The
 * worker then spins forever, and since bun's per-test timeout is a timer on that same blocked
 * thread, nothing ends it but the job's limit: twice on 2026-11-13 the Tests job hung that way
 * in workflows.test.ts. #580 made every test subprocess an awaited Bun.spawn; this keeps it so.
 *
 * It reads the test files, the test helpers (any `testing` file or folder) and bunfig's
 * preloads. A sync spawn in a module a test reaches only through an import is not seen here;
 * the ones left in the repository are reached only from their scripts' own entry points.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
// This file names the calls on purpose, in the pattern's own test.
const SELF = "scripts/ci/sync-spawn.test.ts";

/** A call, not a mention: the name followed by its parenthesis (`Bun.spawnSync(` included). */
const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\s*\(/;

async function trackedFiles(): Promise<string[]> {
  const git = Bun.spawn(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
    git.exited,
  ]);
  if (code !== 0) throw new Error(`git ls-files exited ${code}: ${err}`);
  return out.split("\0").filter(Boolean);
}

test("the pattern finds a call, and not a comment that names one", () => {
  expect(SYNC_SPAWN.test('const r = Bun.spawnSync(["git"]);')).toBe(true);
  expect(SYNC_SPAWN.test('execFileSync ("git", [])')).toBe(true);
  expect(SYNC_SPAWN.test("execSync(`ls`)")).toBe(true);
  expect(SYNC_SPAWN.test("// Awaited, never spawnSync: it can lose the child's exit")).toBe(false);
  expect(SYNC_SPAWN.test('import { spawnSync } from "node:child_process";')).toBe(false);
});

test("no test, test helper or preload calls a synchronous spawn", async () => {
  const preloads = (
    Bun.TOML.parse(readFileSync(join(ROOT, "bunfig.toml"), "utf8")) as {
      test?: { preload?: string[] };
    }
  ).test?.preload?.map((p) => p.replace(/^\.\//, ""));
  const files = (await trackedFiles()).filter(
    (f) =>
      f !== SELF &&
      (/\.test\.tsx?$/.test(f) ||
        (/(^|\/)testing(\/|\.tsx?$)/.test(f) && /\.tsx?$/.test(f)) ||
        preloads?.includes(f)),
  );
  expect(files.length).toBeGreaterThan(400);
  const calls: string[] = [];
  for (const file of files) {
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (SYNC_SPAWN.test(line)) calls.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(calls).toEqual([]);
});

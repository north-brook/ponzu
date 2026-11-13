/**
 * The watchdog CI's Tests job runs bun test under (test-watchdog.ts), with the trace preload
 * (test-trace.ts). A test that blocks its worker's thread is forced here with Atomics.wait,
 * which, like a synchronous spawn that never returns, also keeps bun's own per-test timeout
 * from firing. Every subprocess is awaited, and every wait is on a condition, never on time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trace } from "./test-trace.ts";
import { parsePs, pastTests, report, stillRunning, treeOf, whereIn } from "./test-watchdog.ts";

const WATCHDOG = join(import.meta.dir, "test-watchdog.ts");
const PRELOAD = join(import.meta.dir, "test-trace.ts");
const BLOCK = "const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";

const trace = (over: Partial<Trace>): Trace => ({
  pid: 1,
  worker: "0",
  file: "a.test.ts",
  since: 0,
  stage: "running",
  begun: 0,
  ended: 0,
  ...over,
});

describe("reading where a worker was", () => {
  test("loading, in a test, in a hook before the first, or after one", () => {
    expect(whereIn(trace({ stage: "loading" }))).toStartWith("still loading it");
    expect(whereIn(trace({ begun: 3, ended: 2 }))).toStartWith(
      "in its test number 3 (2 had ended)",
    );
    expect(whereIn(trace({}))).toBe("in a beforeAll hook, before its first test");
    expect(whereIn(trace({ begun: 4, ended: 4 }))).toBe(
      "after its test number 4, in a hook or between tests",
    );
  });

  test("a file is still running only while its worker lives and has not finished it", () => {
    const traces = [
      trace({ pid: 1 }),
      trace({ pid: 2, stage: "done" }),
      trace({ pid: 3, stage: "loading" }),
    ];
    expect(stillRunning(traces, (pid) => pid !== 3).map((t) => t.pid)).toEqual([1]);
  });

  test("a live worker past its file's tests is listed apart: in the file's own teardown, or idle", () => {
    const traces = [
      trace({ pid: 1 }),
      trace({ pid: 2, stage: "done", file: "a.e2e.test.ts", ended: 4 }),
      trace({ pid: 3, stage: "done" }),
    ];
    // Worker 3 has exited: only a live worker can still be in a teardown hook.
    const ended = pastTests(traces, (pid) => pid !== 3);
    expect(ended.map((t) => t.pid)).toEqual([2]);
    const lines = report([], [], 0, ended);
    expect(
      lines.some(
        (l) =>
          l.startsWith("::notice file=a.e2e.test.ts,") && l.includes("own afterAll hooks, or idle"),
      ),
    ).toBe(true);
  });

  test("the process tree is the command and what it started, each under its parent", () => {
    const procs = parsePs(
      [
        "  10     1 S    01:00  0.0 bun test --parallel",
        "  11    10 R    00:59 99.0 bun test --test-worker",
        "  12    11 Z    00:58  0.0 [bash] <defunct>",
        "  13    10 S    00:59  0.0 bun test --test-worker",
        "  20     1 S    01:00  0.0 something else",
      ].join("\n"),
    );
    expect(treeOf(procs, 10).map(({ proc, depth }) => [proc.pid, depth])).toEqual([
      [10, 0],
      [11, 1],
      [12, 2],
      [13, 1],
    ]);
    const lines = report(
      [trace({ pid: 11, file: "x.test.ts", begun: 2, ended: 1 })],
      treeOf(procs, 10),
      0,
    );
    expect(lines[0]).toStartWith(
      "::error file=x.test.ts,title=Still running when the tests were cut off::worker 0 (pid 11)",
    );
    expect(lines).toContain("    12 11 Z 00:58 0.0 [bash] <defunct>");
  });
});

/** A throwaway project whose bunfig preloads the trace, with the given test files. */
async function project(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "watchdog-")));
  mkdirSync(join(dir, "t"));
  await writeFile(join(dir, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, "t", name), body);
  dirs.push(dir);
  return dir;
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts the watchdog over `bun test --parallel=2` in `dir`, its output piped. */
function watch(dir: string, deadline: number) {
  const proc = Bun.spawn(
    [
      process.execPath,
      WATCHDOG,
      "--deadline",
      String(deadline),
      "--trace",
      join(dir, "trace"),
      "--",
      process.execPath,
      "test",
      "--parallel=2",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PONZU_TEST_TRACE: "" } },
  );
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  return {
    proc,
    done: async () => {
      const [code, stdout, stderr] = await Promise.all([proc.exited, out, err]);
      return { code, stdout, stderr };
    },
  };
}

/** Whether `pid` still runs. A zombie has exited, and waits only on whoever reaps it. */
async function running(pid: number) {
  const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stat] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  return stat.trim() !== "" && !stat.trim().startsWith("Z");
}

/** Waits until every process in the report's tree has stopped. Bounded by the test's timeout. */
async function goneAll(stdout: string) {
  const pids = [...stdout.matchAll(/^\s*(\d+) \d+ \S+ /gm)].map((m) => Number(m[1]));
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    while (await running(pid)) await Bun.sleep(20);
  }
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("the watchdog", () => {
  test("passes a finished run's exit through, and says nothing of its own", async () => {
    const dir = await project({
      "fine.test.ts": 'import { test } from "bun:test";\ntest("fine", () => {});\n',
      "also.test.ts": 'import { test } from "bun:test";\ntest("also", () => {});\n',
    });
    const passed = await watch(dir, future()).done();
    expect(passed.code).toBe(0);
    expect(passed.stdout + passed.stderr).not.toContain("::error");
    // Every worker's last file ended, so none of them would be named had it lived on idle.
    const traces = readdirTraces(join(dir, "trace"));
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.map((t) => [t.file, t.stage, t.begun, t.ended])).toEqual(
      traces.map((t) => [t.file, "done", 1, 1]),
    );

    await writeFile(
      join(dir, "t", "bad.test.ts"),
      'import { expect, test } from "bun:test";\ntest("bad", () => { expect(1).toBe(2); });\n',
    );
    const failed = await watch(dir, future()).done();
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain("::error");
  });

  test("cut off, it names the file and test a blocked worker was on, and leaves nothing running", async () => {
    const dir = await project({
      "stuck.test.ts": [
        'import { test } from "bun:test";',
        BLOCK,
        'test("a", () => {});',
        'test("b", () => {});',
        'test("stuck", () => { block(); });',
        'test("d", () => {});',
      ].join("\n"),
      "fine.test.ts": 'import { test } from "bun:test";\ntest("fine", () => {});\n',
    });
    const run = watch(dir, future());
    // Until the worker is inside the third test: the condition, not a guess at how long.
    const stuck = () =>
      readdirTraces(join(dir, "trace")).some(
        (t) => t.file === "t/stuck.test.ts" && t.begun === 3 && t.ended === 2,
      );
    while (!stuck()) await Bun.sleep(20);
    run.proc.kill("SIGTERM");
    const { code, stdout } = await run.done();
    expect(code).toBe(143);
    expect(stdout).toMatch(
      /^::error file=t\/stuck\.test\.ts,title=Still running when the tests were cut off::worker \d+ \(pid \d+\) had been on t\/stuck\.test\.ts for \d+m\d\ds, in its test number 3 \(2 had ended\)/m,
    );
    // fine.test.ts finished, so it is not named.
    expect(stdout).not.toContain("file=t/fine.test.ts");
    expect(stdout).toContain("--test-worker");
    await goneAll(stdout);
  });

  test("a block at a file's top level is named as loading it", async () => {
    const dir = await project({
      "top.test.ts": [
        'import { test } from "bun:test";',
        BLOCK,
        "block();",
        'test("x", () => {});',
      ].join("\n"),
    });
    const run = watch(dir, future());
    const loading = () =>
      readdirTraces(join(dir, "trace")).some(
        (t) => t.file === "t/top.test.ts" && t.stage === "loading",
      );
    while (!loading()) await Bun.sleep(20);
    run.proc.kill("SIGINT");
    const { code, stdout } = await run.done();
    expect(code).toBe(130);
    expect(stdout).toContain("had been on t/top.test.ts for");
    expect(stdout).toContain("still loading it");
    await goneAll(stdout);
  });

  test("a deadline already past cuts the run off at once, exiting 124", async () => {
    const dir = await project({
      "stuck.test.ts": [
        'import { test } from "bun:test";',
        BLOCK,
        'test("x", () => { block(); });',
      ].join("\n"),
    });
    const { code, stdout } = await watch(dir, Math.floor(Date.now() / 1000) - 1).done();
    expect(code).toBe(124);
    expect(stdout).toContain("::group::The processes under bun test");
    await goneAll(stdout);
  });
});

function readdirTraces(folder: string): Trace[] {
  if (!existsSync(folder)) return [];
  const out: Trace[] = [];
  for (const name of new Bun.Glob("*.json").scanSync(folder)) {
    try {
      out.push(JSON.parse(readFileSync(join(folder, name), "utf8")) as Trace);
    } catch {
      // Caught mid-write; the next look reads it whole.
    }
  }
  return out;
}

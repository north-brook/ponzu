import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  backoffMs,
  type Child,
  EXIT_CONFIG,
  runnerEntry,
  STOP_GRACE_MS,
  supervise,
} from "./supervise.ts";

/** A clock and children the test ends by hand. */
function world(stopAfter?: number) {
  let clock = 0;
  const children: {
    exit(code: number | null, signal?: string): void;
    signals: string[];
    killed: number;
  }[] = [];
  const sleeps: number[] = [];
  let stop: (signal: NodeJS.Signals) => void = () => {};
  const stopping = new Promise<NodeJS.Signals>((resolve) => {
    stop = resolve;
  });
  const start = (): Child => {
    let exit!: (r: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      exit = r;
    });
    const record = {
      exit: (code: number | null, signal?: string) => exit({ code, signal: signal ?? null }),
      signals: [] as string[],
      killed: 0,
    };
    children.push(record);
    if (stopAfter !== undefined && children.length === stopAfter)
      queueMicrotask(() => stop("SIGTERM"));
    return {
      pid: children.length,
      exited,
      signal: (name) => {
        record.signals.push(name);
        if (name === "SIGTERM") record.exit(0);
      },
      killGroup: () => {
        record.killed++;
      },
    };
  };
  return {
    children,
    sleeps,
    stop: (s: NodeJS.Signals) => stop(s),
    advance: (ms: number) => {
      clock += ms;
    },
    opts: {
      start,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: () => {},
      stopping,
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the supervisor starts the runner beside it: the bundle's runner.js, or the source's main.ts", () => {
  const dir = "/opt/ponzu/runners/d477fcea";
  expect(runnerEntry(dir, `${dir}/supervise.js`)).toBe(`${dir}/runner.js`);
  expect(runnerEntry("/src", "/src/supervise.ts")).toBe("/src/main.ts");
  expect(runnerEntry()).toBe(join(import.meta.dir, "main.ts"));
});

test("the backoff doubles from a second to thirty", () => {
  expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
    1000, 2000, 4000, 8000, 16000, 30000, 30000,
  ]);
});

test("a crash is restarted with a backoff, and 78 stops for good", async () => {
  const w = world();
  const done = supervise(w.opts);
  await tick();
  w.children[0]!.exit(1);
  await tick();
  w.children[1]!.exit(null, "SIGKILL");
  await tick();
  w.children[2]!.exit(EXIT_CONFIG);
  expect(await done).toBe(EXIT_CONFIG);
  expect(w.sleeps).toEqual([1000, 2000]);
  // What a run left behind is killed before the next one.
  expect(w.children.map((c) => c.killed)).toEqual([1, 1, 1]);
});

test("a long healthy run forgets the failures before it", async () => {
  const w = world();
  const done = supervise(w.opts);
  await tick();
  w.children[0]!.exit(1);
  await tick();
  w.advance(120_000);
  w.children[1]!.exit(1);
  await tick();
  w.children[2]!.exit(0);
  expect(await done).toBe(0);
  expect(w.sleeps).toEqual([1000, 1000]);
});

test("SIGTERM goes to the runner, and the supervisor ends when it has", async () => {
  const w = world(1);
  const code = await supervise(w.opts);
  expect(code).toBe(0);
  expect(w.children).toHaveLength(1);
  expect(w.children[0]!.signals).toEqual(["SIGTERM"]);
  expect(w.children[0]!.killed).toBe(1);
  // The grace was armed, and the runner was not started again.
  expect(w.sleeps).toEqual([STOP_GRACE_MS]);
});

#!/usr/bin/env bun
/**
 * Runs the tests, and names what is still running if they are about to be cut off:
 *
 *   bun scripts/ci/test-watchdog.ts --deadline <unix seconds> --trace <folder> -- bun test ...
 *
 * CI's Tests job (.github/workflows/ci.yml) has a hard limit. A test that blocks its worker's
 * thread, such as Bun 1.4.2's spawnSync losing its child's exit (#580), also blocks bun's own
 * per-test timeout, so a run that hangs prints nothing more until the limit cancels it, and the
 * last file printed is only the last one that finished. This passes the command's exit through
 * untouched. If the command is still running at the deadline, it prints each test file a worker
 * was still on (from the records scripts/ci/test-trace.ts keeps in the trace folder), how long it
 * had been on it and how many of its tests had begun and ended, with an `::error` annotation for
 * each, then the process tree under the command, which shows a zombie child or a browser left
 * open. It then kills that tree and exits 124, so the job fails naming the file, and its later
 * steps (the results upload) still run inside the limit. A cancelled step (SIGINT or SIGTERM)
 * gets the same report, and exits as that signal would.
 *
 * The deadline should fall a minute or so before the job's limit, and well past the run's usual
 * length: it ends only runs the limit would have ended anyway.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { Trace } from "./test-trace.ts";

/** One line of `ps`: a process under the command. */
export interface Proc {
  pid: number;
  ppid: number;
  stat: string;
  etime: string;
  cpu: string;
  args: string;
}

/** Parses `ps -A -o pid=,ppid=,stat=,etime=,pcpu=,args=`. */
export function parsePs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) {
      procs.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        stat: m[3] as string,
        etime: m[4] as string,
        cpu: m[5] as string,
        args: m[6] as string,
      });
    }
  }
  return procs;
}

/** `root` and everything under it, each after its parent, with its depth. */
export function treeOf(procs: Proc[], root: number): { proc: Proc; depth: number }[] {
  const out: { proc: Proc; depth: number }[] = [];
  const visit = (pid: number, depth: number) => {
    const proc = procs.find((p) => p.pid === pid);
    if (proc) out.push({ proc, depth });
    for (const child of procs.filter((p) => p.ppid === pid && p.pid !== pid)) {
      visit(child.pid, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/** The records of workers that were still on a file: alive, and not done with it. */
export function stillRunning(traces: Trace[], alive: (pid: number) => boolean): Trace[] {
  return traces.filter((t) => t.stage !== "done" && alive(t.pid));
}

function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Where in its file a worker was, in words. */
export function whereIn(t: Trace): string {
  if (t.stage === "loading") return "still loading it (its module or a preload had not finished)";
  if (t.begun > t.ended) {
    return `in its test number ${t.begun} (${t.ended} had ended): the first test of the file not printed above`;
  }
  if (t.begun === 0) return "in a beforeAll hook, before its first test";
  return `after its test number ${t.ended}, in a hook or between tests`;
}

/** The report's lines: one annotation per file still running, then the process tree. */
export function report(running: Trace[], tree: { proc: Proc; depth: number }[], now: number) {
  const lines: string[] = [];
  if (running.length === 0) {
    lines.push(
      "::error title=Tests cut off::The tests were still running at the deadline, but no test file was (bun itself, or a file between its tests and its report).",
    );
  }
  for (const t of running) {
    const what = `worker ${t.worker} (pid ${t.pid}) had been on ${t.file} for ${minutes(now - t.since)}, ${whereIn(t)}`;
    lines.push(`::error file=${t.file},title=Still running when the tests were cut off::${what}`);
  }
  lines.push("::group::The processes under bun test (stat Z is a child that exited unreaped)");
  lines.push("PID PPID STAT ELAPSED %CPU COMMAND");
  for (const { proc, depth } of tree) {
    lines.push(
      `${"  ".repeat(depth)}${proc.pid} ${proc.ppid} ${proc.stat} ${proc.etime} ${proc.cpu} ${proc.args.slice(0, 300)}`,
    );
  }
  lines.push("::endgroup::");
  return lines;
}

function readTraces(folder: string): Trace[] {
  const traces: Trace[] = [];
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    try {
      traces.push(JSON.parse(readFileSync(join(folder, name), "utf8")) as Trace);
    } catch {
      // Caught mid-write: that worker had just moved on, so it was not stuck.
    }
  }
  return traces;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processTree(root: number) {
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,stat=,etime=,pcpu=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  return treeOf(parsePs(text), root);
}

export function parseArgs(argv: string[]) {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const value = (flag: string) => {
    const i = own.indexOf(flag);
    return i === -1 ? undefined : own[i + 1];
  };
  const deadline = Number(value("--deadline"));
  const trace = value("--trace");
  if (!Number.isFinite(deadline) || !trace || command.length === 0) {
    throw new Error(
      "usage: bun scripts/ci/test-watchdog.ts --deadline <unix seconds> --trace <folder> -- <command...>",
    );
  }
  return { deadline: deadline * 1000, trace, command };
}

/**
 * Stops `root` and everything under it, and gives back their pids. Asked again until no new
 * process turns up: one started between a look and the stop is caught by the next look, and
 * a stopped process starts nothing.
 */
async function stopTree(root: number): Promise<number[]> {
  const stopped = new Set<number>();
  for (;;) {
    const fresh = (await processTree(root)).filter(({ proc }) => !stopped.has(proc.pid));
    if (fresh.length === 0) return [...stopped];
    for (const { proc } of fresh) {
      stopped.add(proc.pid);
      try {
        process.kill(proc.pid, "SIGSTOP");
      } catch {
        // Already gone.
      }
    }
  }
}

if (import.meta.main) {
  const { deadline, trace, command } = parseArgs(process.argv.slice(2));
  mkdirSync(trace, { recursive: true });
  // The deadline, or the step being cancelled (Actions sends SIGINT, then SIGTERM), cuts the
  // tests off: either way the report is printed before they are killed. The handlers go in
  // before bun starts, so no signal can end this first and leave the tests running unwatched.
  let timer: Timer | undefined;
  const cutOff = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(124), Math.max(0, deadline - Date.now()));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => resolve(128 + constants.signals[signal]));
    }
  });
  const child = Bun.spawn(command, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, PONZU_TEST_TRACE: trace },
  });
  const outcome = await Promise.race([
    child.exited.then(() => ({ exited: true }) as const),
    cutOff.then((code) => ({ exited: false, code }) as const),
  ]);
  clearTimeout(timer);
  if (outcome.exited) {
    // Killed by a signal, exit the way a shell reports it.
    const signal = child.signalCode;
    if (signal === null) process.exit(child.exitCode ?? 1);
    process.exit(128 + (typeof signal === "number" ? signal : constants.signals[signal]));
  }
  // Read before anything is stopped, so the report shows each process as it was running.
  const tree = await processTree(child.pid);
  const running = stillRunning(readTraces(trace), alive);
  for (const line of report(running, tree, Date.now())) console.log(line);
  for (const pid of await stopTree(child.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  process.exit(outcome.code);
}

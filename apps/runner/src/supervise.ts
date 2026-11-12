/*
 * The runner's supervisor, for a sandbox that runs no init and no service manager. The API
 * starts it at every start of the sandbox, as root, with one detached command whose environment
 * is the runner's (the canvas, the runner and port tokens, the one Claude credential, the repo's
 * secrets). Nothing of that environment is written anywhere: it lives in this process and the
 * runner's, and neither is readable by the agent's user.
 *
 *   flock -n /run/ponzu-supervisor.lock bun supervise.js
 *
 * It runs the runner as its own user (`ponzu`, group `agent`, umask 002, CAP_DAC_READ_SEARCH so
 * it can read Claude Code's 0600 transcripts), restarts it when it fails, with a backoff, and
 * stops for good when it exits 78 (the environment is wrong, the token was revoked, or a newer
 * runner took the canvas: a restart will not mend it) or 0. SIGTERM is passed to the runner,
 * which finishes in order; what it started is killed once it has exited or after 20 s.
 */
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { chownSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The runner's "do not restart". */
export const EXIT_CONFIG = 78;
/** How long the runner has to finish after SIGTERM before what is left is killed. */
export const STOP_GRACE_MS = 20_000;
/** A run this long resets the backoff: the failure before it is forgotten. */
export const HEALTHY_RUN_MS = 60_000;

/** Seconds before the `attempt`th restart in a row: 1, 2, 4 … up to 30. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export interface Child {
  pid: number | undefined;
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Signals the runner alone. */
  signal(name: NodeJS.Signals): void;
  /** Kills what is left of its process group. */
  killGroup(): void;
}

export interface SuperviseOptions {
  start(): Child;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** Resolves when the supervisor is told to stop (SIGTERM, SIGINT, SIGHUP). */
  stopping: Promise<NodeJS.Signals>;
}

/** Runs the runner until it should not run again. Answers the supervisor's exit code. */
export async function supervise(opts: SuperviseOptions): Promise<number> {
  let attempt = 0;
  let stopSignal: NodeJS.Signals | null = null;
  const stopped = opts.stopping.then((signal) => {
    stopSignal = signal;
    return signal;
  });
  for (;;) {
    const child = opts.start();
    const began = opts.now();
    opts.log(`runner started (pid ${child.pid})`);
    const result = await Promise.race([child.exited, stopped.then(() => null)]);
    if (result === null) {
      // Told to stop: the runner first, then what it left.
      opts.log(`${stopSignal}: stopping the runner`);
      child.signal("SIGTERM");
      const done = await Promise.race([child.exited, opts.sleep(STOP_GRACE_MS).then(() => null)]);
      if (done === null) opts.log(`the runner did not stop within ${STOP_GRACE_MS / 1000} s`);
      child.killGroup();
      return 0;
    }
    child.killGroup();
    const { code, signal } = result;
    opts.log(`runner exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    if (stopSignal) return 0;
    if (code === EXIT_CONFIG) return EXIT_CONFIG;
    if (code === 0) return 0;
    attempt = opts.now() - began >= HEALTHY_RUN_MS ? 1 : attempt + 1;
    const wait = backoffMs(attempt);
    opts.log(`restarting in ${wait / 1000} s`);
    const woke = await Promise.race([opts.sleep(wait).then(() => true), stopped.then(() => false)]);
    if (!woke) return 0;
  }
}

/**
 * The runner this supervisor starts: the one beside it, from the same bundle
 * (/opt/ponzu/runners/<sha256>/), or main.ts beside the source.
 */
export function runnerEntry(
  dir: string = import.meta.dir,
  file: string = import.meta.path,
): string {
  return join(dir, file.endsWith(".ts") ? "main.ts" : "runner.js");
}

/** What the image says about where things are (provision.sh writes it): no secrets. */
interface ImageConfig {
  bun: string;
  user: string;
  group: string;
  home: string;
  runtimeDir: string;
  env: Record<string, string>;
}

/** The variables of the start command that are not the runner's business. */
const DROPPED = /^(SUDO_|LS_COLORS$|MAIL$|_$)/;

function startRunner(image: ImageConfig): Child {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !DROPPED.test(name)) env[name] = value;
  Object.assign(env, image.env, {
    HOME: image.home,
    USER: image.user,
    LOGNAME: image.user,
  });
  // As the runner's user and the agent's group, with the one capability the unit gave it. It
  // leads its own process group, so what it started can be killed with it.
  const child: ChildProcess = spawnChild(
    "setpriv",
    [
      `--reuid=${image.user}`,
      `--regid=${image.group}`,
      "--init-groups",
      "--inh-caps=+dac_read_search",
      "--ambient-caps=+dac_read_search",
      "--",
      image.bun,
      runnerEntry(),
    ],
    { cwd: image.home, env, stdio: "inherit", detached: true },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
  return {
    pid: child.pid,
    exited,
    signal: (name) => {
      try {
        child.kill(name);
      } catch {}
    },
    killGroup: () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    },
  };
}

if (import.meta.main) {
  const log = (line: string) => console.error(`[supervisor] ${line}`);
  const image = JSON.parse(
    readFileSync(process.env.PONZU_IMAGE_CONFIG ?? "/opt/ponzu/runner.json", "utf8"),
  ) as ImageConfig;
  // The runtime folder: the git credential socket, which only the runner and the agent's
  // group may open. In memory, so it is never part of a snapshot.
  mkdirSync(image.runtimeDir, { recursive: true, mode: 0o750 });
  const ids = (what: string) =>
    Number(
      readFileSync(what === "user" ? "/etc/passwd" : "/etc/group", "utf8")
        .split("\n")
        .find((l) => l.startsWith(`${what === "user" ? image.user : image.group}:`))
        ?.split(":")[2],
    );
  chownSync(image.runtimeDir, ids("user"), ids("group"));
  process.umask(0o002);
  const stopping = new Promise<NodeJS.Signals>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.once(signal, () => resolve(signal));
  });
  const code = await supervise({
    start: () => startRunner(image),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log,
    stopping,
  });
  log(`exiting ${code}`);
  process.exit(code);
}

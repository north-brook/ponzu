/*
 * A SandboxProvider that lives in memory, for testing the API and the runner lifecycle without
 * a network. It keeps the rules that shape that code: starts and stops take time, an explicit
 * stop stays warm for ten minutes and an auto-stop does not, a cold start loses processes and
 * /tmp, a new environment forces one, a call sent during a start is held until it lands, an
 * idempotency key is forgotten after a day, and awake time is metered.
 *
 * Time is a FakeClock. Sleeping moves it forward at once, so code that polls finishes
 * immediately and the test decides how long things took.
 */

import type { Clock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import type {
  Created,
  CreateOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ProcessStatus,
  Resumed,
  ResumeOptions,
  Sandbox,
  SandboxAddress,
  SandboxProvider,
  SandboxSize,
  Snapshot,
  Usage,
  Wake,
  WakeOptions,
} from "./provider.ts";
import { ensureAwake } from "./wake.ts";

export class FakeClock implements Clock {
  #ms: number;
  #timeouts: Array<{ at: number; controller: AbortController }> = [];

  constructor(startAt = Date.UTC(2026, 0, 1)) {
    this.#ms = startAt;
  }

  now(): number {
    return this.#ms;
  }

  /** Moves time forward, aborting every `timeout` signal that comes due. */
  advance(ms: number): void {
    this.#ms += ms;
    const due = this.#timeouts.filter((timeout) => timeout.at <= this.#ms);
    this.#timeouts = this.#timeouts.filter((timeout) => timeout.at > this.#ms);
    for (const { controller } of due) {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  timeout(ms: number): AbortSignal {
    const controller = new AbortController();
    this.#timeouts.push({ at: this.#ms + ms, controller });
    return controller.signal;
  }
}

export interface FakeCommand {
  id: string;
  command: string;
  cwd: string | undefined;
  /** The sandbox's environment when the command ran. */
  env: Record<string, string>;
  /** Started with `spawn` rather than `exec`. */
  detached: boolean;
}

interface Machine {
  id: string;
  size: SandboxSize;
  labels: Record<string, string>;
  env: Record<string, string>;
  state: "awake" | "asleep";
  /** A start or stop under way, and when it lands. */
  moving: { to: "awake"; at: number; cold: boolean } | { to: "asleep"; at: number } | null;
  /** A stop holds the machine until then: a resume before it is `busy`. */
  busyUntil: number;
  /** Why the last start failed, until the next one is accepted. */
  reason: string | null;
  /** Set by `failNextStart`: what the start under way, or the next one, fails with. */
  startFails: string | null;
  autoStopSeconds: number;
  autoStopAt: number | null;
  /** An explicit stop keeps memory until then; a resume before it is warm. */
  warmUntil: number;
  awakeMs: number;
  awakeSince: number | null;
  expired: boolean;
  files: Map<string, Uint8Array>;
  /** pid to whether it still runs. A pid that is missing is one the sandbox lost. */
  processes: Map<number, boolean>;
}

interface SavedSnapshot {
  sandboxId: string;
  files: Map<string, Uint8Array>;
  createdAt: number;
  readyAt: number;
  /** The save this one replaces, which goes on serving `create` until this one is ready. */
  before: Map<string, Uint8Array> | null;
}

const USD_PER_AWAKE_HOUR: Record<SandboxSize, number> = {
  small: 0.018,
  medium: 0.036,
  large: 0.072,
  xlarge: 0.2,
};

/** How long a provider remembers an idempotency key. */
const KEY_MEMORY_MS = 24 * 60 * 60_000;
/** How long a provider holds a call sent during a start before refusing it. */
const HELD_WHILE_STARTING_MS = 60_000;
const DEFAULT_COMMAND_SECONDS = 30;
const MAX_COMMAND_SECONDS = 600;

export class FakeProvider implements SandboxProvider {
  readonly clock: FakeClock;
  /** How long a start takes. Raise `cold` past a wake's timeout to act out a start that hangs. */
  startMs = { cold: 3_000, warm: 1_000 };
  stopMs = 2_000;
  /**
   * How long past the end of a stop a resume is still refused as `busy`. A real provider has
   * held a machine for a moment after the sandbox read asleep; raise this to act that out.
   */
  stopLingerMs = 0;
  snapshotMs = 4_000;
  warmWindowMs = 10 * 60_000;
  /** Every command run or spawned, oldest first. */
  readonly commands: FakeCommand[] = [];
  /** What `exec` and `execStream` answer. Unset, every command exits 0 with no output. */
  onExec: ((command: FakeCommand) => Partial<ExecResult> | undefined) | null = null;

  readonly #machines = new Map<string, Machine>();
  readonly #snapshots = new Map<string, SavedSnapshot>();
  readonly #created = new Map<string, { id: string; options: string; at: number }>();
  readonly #failures = new Map<keyof SandboxProvider, Error[]>();
  #nextId = 1;
  #nextPid = 1000;

  constructor(clock = new FakeClock()) {
    this.clock = clock;
  }

  /** Makes the next call to `method` fail with `error`, or the next `times` of them. Calls queue up. */
  failNext(method: keyof SandboxProvider, error: Error, times = 1): void {
    const queued = this.#failures.get(method) ?? [];
    this.#failures.set(method, [...queued, ...Array<Error>(times).fill(error)]);
  }

  /**
   * Makes the start under way, or else the next one, fail: the sandbox ends up asleep with
   * `reason`, as when a provider loses the machine it was starting.
   */
  failNextStart(id: string, reason: string): void {
    this.#machine(id).startFails = reason;
  }

  /** Deletes a sleeping sandbox's disk, as a provider does after long enough: resume then fails. */
  expire(id: string): void {
    this.#machine(id).expired = true;
  }

  /** The sandbox's current environment. */
  env(id: string): Record<string, string> {
    return { ...this.#machine(id).env };
  }

  async create(options: CreateOptions): Promise<Created> {
    this.#fail("create");
    const now = this.clock.now();
    const sent = canonical(options);
    const before = this.#created.get(options.idempotencyKey);
    // A key is forgotten after a day, and with its sandbox: then it makes a new one.
    if (before && this.#machines.has(before.id) && now - before.at < KEY_MEMORY_MS) {
      if (before.options !== sent) {
        throw new SandboxError(
          "conflict",
          `idempotency key ${options.idempotencyKey} was used with different options`,
        );
      }
      return this.#createdAs(this.#machine(before.id), options.ports);
    }

    let files = new Map<string, Uint8Array>();
    if (options.from) {
      const base = this.#snapshots.get(options.from);
      const served = base && (base.readyAt <= now ? base.files : base.before);
      if (!served) throw new SandboxError("not_found", `no snapshot ${options.from}`);
      files = new Map(served);
    }
    const machine: Machine = {
      id: `sb_${this.#nextId++}`,
      size: options.size ?? "small",
      labels: { ...options.labels },
      env: { ...options.env },
      state: "asleep",
      moving: { to: "awake", at: now + this.startMs.cold, cold: true },
      busyUntil: 0,
      reason: null,
      startFails: null,
      autoStopSeconds: options.autoStopSeconds,
      autoStopAt: now + options.autoStopSeconds * 1000,
      warmUntil: 0,
      awakeMs: 0,
      awakeSince: null,
      expired: false,
      files,
      processes: new Map(),
    };
    this.#machines.set(machine.id, machine);
    this.#created.set(options.idempotencyKey, { id: machine.id, options: sent, at: now });
    return this.#createdAs(machine, options.ports);
  }

  async get(id: string): Promise<Sandbox> {
    this.#fail("get");
    const machine = this.#settle(id);
    return machine
      ? toSandbox(machine)
      : { id, state: "gone", labels: {}, autoStopAt: null, reason: null };
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Sandbox[]> {
    this.#fail("list");
    const wanted = Object.entries(filter.labels ?? {});
    return [...this.#machines.keys()]
      .map((id) => toSandbox(this.#machine(id)))
      .filter((sandbox) => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  async ensureAwake(id: string, options?: WakeOptions): Promise<Wake> {
    this.#fail("ensureAwake");
    return ensureAwake(this, this.clock, id, options);
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<Resumed> {
    this.#fail("resume");
    const machine = this.#machine(id);
    const now = this.clock.now();
    if (now < machine.busyUntil) {
      throw new SandboxError("busy", `a stop still holds sandbox ${id}`, {
        retryAfterSeconds: Math.ceil((machine.busyUntil - now) / 1000),
      });
    }
    if (machine.moving?.to === "awake") {
      // A start someone else began. It can be joined, but not given another environment.
      if (options.env) {
        throw new SandboxError("busy", `a start of sandbox ${id} is already under way`, {
          retryAfterSeconds: Math.ceil((machine.moving.at - now) / 1000),
        });
      }
      return { sandbox: toSandbox(machine), coldStart: machine.moving.cold };
    }
    if (machine.state === "awake") {
      if (options.env) {
        throw new SandboxError(
          "conflict",
          `sandbox ${id} is awake, so its environment was not replaced; stop it first`,
        );
      }
      return { sandbox: toSandbox(machine), coldStart: false };
    }
    if (machine.expired) {
      throw new SandboxError("snapshot_expired", `sandbox ${id} slept too long; its disk is gone`);
    }

    const coldStart = options.env !== undefined || now >= machine.warmUntil;
    if (coldStart) {
      machine.processes.clear();
      for (const path of machine.files.keys())
        if (path.startsWith("/tmp/")) machine.files.delete(path);
      if (options.env) machine.env = { ...options.env };
    }
    if (options.autoStopSeconds !== undefined) machine.autoStopSeconds = options.autoStopSeconds;
    machine.autoStopAt = now + machine.autoStopSeconds * 1000;
    machine.reason = null;
    machine.moving = {
      to: "awake",
      at: now + (coldStart ? this.startMs.cold : this.startMs.warm),
      cold: coldStart,
    };
    return { sandbox: toSandbox(machine), coldStart };
  }

  async stop(id: string): Promise<Sandbox> {
    this.#fail("stop");
    const machine = this.#machine(id);
    if (machine.state === "awake" || machine.moving?.to === "awake") {
      const now = this.clock.now();
      this.#meterOff(machine, now);
      machine.state = "asleep";
      machine.moving = { to: "asleep", at: now + this.stopMs };
      machine.busyUntil = now + this.stopMs + this.stopLingerMs;
      machine.autoStopAt = null;
      machine.warmUntil = now + this.warmWindowMs;
    }
    return toSandbox(machine);
  }

  async extend(id: string, seconds: number): Promise<Sandbox> {
    this.#fail("extend");
    const machine = this.#machine(id);
    machine.autoStopSeconds = seconds;
    if (machine.autoStopAt !== null) machine.autoStopAt = this.clock.now() + seconds * 1000;
    return toSandbox(machine);
  }

  async destroy(id: string): Promise<void> {
    this.#fail("destroy");
    this.#machines.delete(id);
  }

  async exec(id: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.#fail("exec");
    return this.#run(id, command, options);
  }

  async *execStream(
    id: string,
    command: string,
    options: ExecOptions = {},
  ): AsyncGenerator<ExecEvent> {
    this.#fail("execStream");
    const result = this.#run(id, command, options);
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", exitCode: result.exitCode, timedOut: result.timedOut };
  }

  async spawn(
    id: string,
    command: string,
    options: { cwd?: string } = {},
  ): Promise<{ pid: number }> {
    this.#fail("spawn");
    const machine = this.#reach(id);
    this.commands.push({ id, command, cwd: options.cwd, env: { ...machine.env }, detached: true });
    const pid = this.#nextPid++;
    machine.processes.set(pid, true);
    return { pid };
  }

  async process(id: string, pid: number): Promise<ProcessStatus> {
    this.#fail("process");
    const running = this.#reach(id).processes.get(pid);
    if (running === undefined) return { state: "lost", exitCode: null, stdout: "", stderr: "" };
    return running
      ? { state: "running", exitCode: null, stdout: "", stderr: "" }
      : { state: "exited", exitCode: 143, stdout: "", stderr: "" };
  }

  async kill(id: string, pid: number): Promise<void> {
    this.#fail("kill");
    const { processes } = this.#reach(id);
    if (processes.has(pid)) processes.set(pid, false);
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    this.#fail("readFile");
    const bytes = this.#reach(id).files.get(absolute(path));
    if (!bytes) throw new SandboxError("not_found", `no file ${path} in sandbox ${id}`);
    return bytes.slice();
  }

  async writeFile(id: string, path: string, content: Uint8Array | string): Promise<void> {
    this.#fail("writeFile");
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
    this.#reach(id).files.set(absolute(path), bytes);
  }

  async address(id: string, port: number): Promise<SandboxAddress> {
    this.#fail("address");
    return toAddress(this.#awake(id).id, port);
  }

  async saveSnapshot(id: string, name: string): Promise<Snapshot> {
    this.#fail("saveSnapshot");
    const machine = this.#machine(id);
    const now = this.clock.now();
    const last = this.#snapshots.get(name);
    if (last && last.readyAt > now) {
      throw new SandboxError("conflict", `snapshot ${name} is already being saved`);
    }
    this.#snapshots.set(name, {
      sandboxId: id,
      files: new Map(machine.files),
      createdAt: now,
      readyAt: now + this.snapshotMs,
      before: last?.files ?? null,
    });
    return this.#snapshot(name)!;
  }

  async getSnapshot(name: string): Promise<Snapshot | null> {
    this.#fail("getSnapshot");
    return this.#snapshot(name);
  }

  async listSnapshots(): Promise<Snapshot[]> {
    this.#fail("listSnapshots");
    return [...this.#snapshots.keys()].map((name) => this.#snapshot(name)!);
  }

  async deleteSnapshot(name: string): Promise<void> {
    this.#fail("deleteSnapshot");
    this.#snapshots.delete(name);
  }

  async usage(id: string): Promise<Usage> {
    this.#fail("usage");
    const machine = this.#machine(id);
    const running = machine.awakeSince === null ? 0 : this.clock.now() - machine.awakeSince;
    const awakeSeconds = (machine.awakeMs + running) / 1000;
    return {
      awakeSeconds,
      costUsd: (awakeSeconds / 3600) * USD_PER_AWAKE_HOUR[machine.size],
      awake: machine.awakeSince !== null,
    };
  }

  #fail(method: keyof SandboxProvider): void {
    const error = this.#failures.get(method)?.shift();
    if (error) throw error;
  }

  /** Brings a machine up to the clock: lands a finished start or stop, then applies the auto-stop. */
  #settle(id: string): Machine | undefined {
    const machine = this.#machines.get(id);
    if (!machine) return undefined;
    const now = this.clock.now();
    if (machine.moving && now >= machine.moving.at) {
      if (machine.moving.to === "awake" && machine.startFails !== null) {
        machine.reason = machine.startFails;
        machine.startFails = null;
        machine.autoStopAt = null;
        machine.warmUntil = 0;
      } else {
        machine.state = machine.moving.to;
        if (machine.state === "awake") machine.awakeSince = machine.moving.at;
      }
      machine.moving = null;
    }
    if (machine.state === "awake" && machine.autoStopAt !== null && now >= machine.autoStopAt) {
      this.#meterOff(machine, machine.autoStopAt);
      machine.state = "asleep";
      machine.autoStopAt = null;
      // An auto-stop does not keep the machine: the next resume is cold.
      machine.warmUntil = 0;
    }
    return machine;
  }

  #meterOff(machine: Machine, at: number): void {
    if (machine.awakeSince !== null) machine.awakeMs += Math.max(0, at - machine.awakeSince);
    machine.awakeSince = null;
  }

  #machine(id: string): Machine {
    const machine = this.#settle(id);
    if (!machine) throw new SandboxError("not_found", `no sandbox ${id}`);
    return machine;
  }

  #awake(id: string): Machine {
    const machine = this.#machine(id);
    if (machine.state !== "awake") {
      throw new SandboxError("not_running", `sandbox ${id} is ${toSandbox(machine).state}`);
    }
    return machine;
  }

  /**
   * The machine, for a call that goes to it: a command, a file, a process. Sent during a start,
   * such a call is held until the start lands, for a minute at most, and so takes that long.
   */
  #reach(id: string): Machine {
    const { moving } = this.#machine(id);
    if (moving?.to === "awake") {
      this.clock.advance(Math.min(moving.at - this.clock.now(), HELD_WHILE_STARTING_MS));
    }
    return this.#awake(id);
  }

  #run(id: string, command: string, options: ExecOptions): ExecResult {
    const seconds = options.timeoutSeconds ?? DEFAULT_COMMAND_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_COMMAND_SECONDS) {
      throw new SandboxError(
        "rejected",
        `timeoutSeconds must be a whole number from 1 to ${MAX_COMMAND_SECONDS}`,
      );
    }
    const machine = this.#reach(id);
    const ran = { id, command, cwd: options.cwd, env: { ...machine.env }, detached: false };
    this.commands.push(ran);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      ...this.onExec?.(ran),
    };
  }

  #createdAs(machine: Machine, ports: number[] = []): Created {
    return {
      sandbox: toSandbox(machine),
      addresses: ports.map((port) => toAddress(machine.id, port)),
    };
  }

  #snapshot(name: string): Snapshot | null {
    const saved = this.#snapshots.get(name);
    if (!saved) return null;
    const ready = saved.readyAt <= this.clock.now();
    // While a name is saved over, its size is still that of the save being replaced.
    const served = ready ? saved.files : saved.before;
    let sizeBytes = 0;
    for (const bytes of served?.values() ?? []) sizeBytes += bytes.byteLength;
    return {
      name,
      state: ready ? "ready" : "saving",
      sandboxId: saved.sandboxId,
      sizeBytes: served ? sizeBytes : null,
      createdAt: saved.createdAt,
      error: null,
    };
  }
}

function toSandbox(machine: Machine): Sandbox {
  return {
    id: machine.id,
    state: machine.moving
      ? machine.moving.to === "awake"
        ? "starting"
        : "stopping"
      : machine.state,
    labels: { ...machine.labels },
    autoStopAt: machine.autoStopAt,
    reason: machine.reason,
  };
}

/** JSON with every object's keys in order, so the same options compare equal however they were built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

function toAddress(id: string, port: number): SandboxAddress {
  const token = `fake-token-${id}-${port}`;
  return {
    port,
    url: `https://${id.replace("_", "-")}-${port}.sandbox.test`,
    token,
    headers: { "x-sandbox-token": token },
    query: { token },
  };
}

/** Relative paths are under the sandbox user's home, as on a real provider. */
function absolute(path: string): string {
  return path.startsWith("/") ? path : `/home/user/${path}`;
}

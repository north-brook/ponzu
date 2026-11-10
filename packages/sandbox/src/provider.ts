/*
 * What Ponzu needs from whoever runs its sandboxes: one Linux machine per design that can be put
 * to sleep and woken, takes commands and files, and answers on a port. The API owns the
 * lifecycle; a provider only does what it is told and reports what is true.
 *
 * Nothing here names a vendor. Every method fails with a `SandboxError`.
 */

/**
 * `awake`: running, and billed. `asleep`: stopped with its disk kept; `resume` brings it back.
 * `gone`: destroyed, or never existed. `starting` and `stopping` are the moves between them.
 */
export type SandboxState = "starting" | "awake" | "stopping" | "asleep" | "gone";

/** 2 vCPU and 4 GB, doubling at each step. */
export type SandboxSize = "small" | "medium" | "large" | "xlarge";

export interface Sandbox {
  id: string;
  state: SandboxState;
  labels: Record<string, string>;
  /**
   * When the provider stops the sandbox by itself unless `extend` moves it, in epoch
   * milliseconds. Null when it is not awake or has no deadline.
   */
  autoStopAt: number | null;
  /** Why it is not awake, when the provider gives a reason (a failed start, a lost machine). */
  reason: string | null;
}

export interface CreateOptions {
  /**
   * Makes a retried create return the first sandbox instead of a second one. A retry must send
   * the same options, `env` included: the same key with different options is a `conflict`.
   */
  idempotencyKey: string;
  /** The base snapshot to start from. Absent means the provider's stock image. */
  from?: string;
  /** Defaults to `small`. */
  size?: SandboxSize;
  /** A name for people reading the provider's own dashboard. */
  name?: string;
  labels?: Record<string, string>;
  /** The sandbox's whole environment. The only place a secret may go. */
  env?: Record<string, string>;
  /** Ports to give a public address. Their addresses come back at once, before anything listens. */
  ports?: number[];
  /**
   * The safety net: the provider stops the sandbox this long after the create unless `extend`
   * pushes it out. Not idle detection, and the stop it causes is the slow kind to wake from.
   */
  autoStopSeconds: number;
}

export interface Created {
  sandbox: Sandbox;
  /** One per requested port. A port the provider could not expose yet is missing: ask `address` once awake. */
  addresses: SandboxAddress[];
}

export interface ResumeOptions {
  /** Replaces the whole environment. This forces a cold start, so send it only when it changed. */
  env?: Record<string, string>;
  /** A new auto-stop length, counted from the resume. Absent keeps the one it had. */
  autoStopSeconds?: number;
}

export interface Resumed {
  sandbox: Sandbox;
  /**
   * True when the sandbox comes back on a fresh machine: its disk and its services return,
   * its memory and hand-started processes do not, and the start counts against the account's
   * start limits. False when it was only frozen, or was already awake.
   */
  coldStart: boolean;
}

export interface WakeOptions extends ResumeOptions {
  /** How long to wait before giving up with `unavailable`. Defaults to 90 seconds. */
  timeoutMs?: number;
}

export interface Wake {
  sandbox: Sandbox;
  /** `none`: it was already awake. `warm`: it was frozen and thawed. `cold`: it booted. */
  start: "none" | "warm" | "cold";
  /** How long the call took: until the sandbox was awake and, after a start, had taken a command. */
  ms: number;
}

export interface ExecOptions {
  /** Absolute, or relative to the sandbox user's home. It must exist. */
  cwd?: string;
  /** The command is killed after this long. Defaults to 30. Providers cap it; `spawn` has no limit. */
  timeoutSeconds?: number;
}

export interface ExecResult {
  /** Null when the command ended without one. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The provider cut the output because there was too much of it. */
  truncated: boolean;
}

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  /** Always last. A stream that ends without it throws instead. */
  | { type: "exit"; exitCode: number | null; timedOut: boolean };

export interface ProcessStatus {
  /** `lost`: the sandbox no longer knows the process, as after a cold start. */
  state: "running" | "exited" | "lost";
  exitCode: number | null;
  /** The end of what it wrote, at most 64 KB of each. */
  stdout: string;
  stderr: string;
}

export interface SandboxAddress {
  port: number;
  /** The https origin of the port, with no credential in it. Safe to log. */
  url: string;
  /**
   * The shared secret that opens the address: anyone holding it gets in. Null when the port
   * is open to everyone. Keep it, `headers` and `query` out of logs.
   */
  token: string | null;
  /** Send these on a request from a server. */
  headers: Record<string, string>;
  /** Or add these to the URL, where headers cannot be set (a browser's WebSocket). */
  query: Record<string, string>;
}

export interface Snapshot {
  name: string;
  /** Only a `ready` snapshot can be created from. */
  state: "saving" | "ready" | "failed";
  /** The sandbox it was saved from. */
  sandboxId: string;
  /** Null until it is ready. */
  sizeBytes: number | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Why it failed, when it did. */
  error: string | null;
}

export interface Usage {
  /** Seconds the sandbox has spent awake since it was created. */
  awakeSeconds: number;
  /** What the provider charges for them at list price, in US dollars. */
  costUsd: number;
  /** Whether the meter is running now. */
  awake: boolean;
}

export interface SandboxProvider {
  /** Returns as soon as the provider has accepted it, usually still `starting`. */
  create(options: CreateOptions): Promise<Created>;

  /** Never fails for a missing sandbox: that is `state: "gone"`. */
  get(id: string): Promise<Sandbox>;

  /** Every sandbox that exists, awake or asleep, carrying all of `labels`. */
  list(filter?: { labels?: Record<string, string> }): Promise<Sandbox[]>;

  /**
   * Makes sure the sandbox takes commands: resumes it if it is asleep, waits out a stop or a
   * start already under way, and after a start returns only once a command has run. `env` and
   * `autoStopSeconds` apply only if this call resumes it. `not_found` when it is gone.
   */
  ensureAwake(id: string, options?: WakeOptions): Promise<Wake>;

  /**
   * Starts waking a sleeping sandbox and returns without waiting for it. A sandbox that is
   * already awake is left alone, unless `env` was given: its environment cannot change while it
   * runs, so that is a `conflict`. `snapshot_expired` when its disk is gone.
   */
  resume(id: string, options?: ResumeOptions): Promise<Resumed>;

  /**
   * Starts putting the sandbox to sleep and returns without waiting. The disk is kept. Memory
   * may be kept for a few minutes, which is what makes the next resume warm. Stopping a
   * sandbox that is asleep does nothing.
   */
  stop(id: string): Promise<Sandbox>;

  /** Moves the auto-stop deadline to `seconds` from now. */
  extend(id: string, seconds: number): Promise<Sandbox>;

  /** Deletes the sandbox and its disk for good, and returns once it is gone. Fine to repeat. */
  destroy(id: string): Promise<void>;

  /**
   * Runs a shell command and waits for it. The provider may keep the command text, so a secret
   * never goes in it: use `env` or `writeFile`. A non-zero exit is a result, not an error.
   */
  exec(id: string, command: string, options?: ExecOptions): Promise<ExecResult>;

  /** The same, with output as it is written. Stop iterating to stop listening; the command runs on. */
  execStream(id: string, command: string, options?: ExecOptions): AsyncIterable<ExecEvent>;

  /** Starts a command that outlives the call and has no time limit. It dies with a cold start. */
  spawn(id: string, command: string, options?: { cwd?: string }): Promise<{ pid: number }>;

  process(id: string, pid: number): Promise<ProcessStatus>;

  /** Ends a spawned process and everything it started. Fine to repeat. */
  kill(id: string, pid: number): Promise<void>;

  /** `path` is absolute, or relative to the sandbox user's home. `not_found` when there is no such file. */
  readFile(id: string, path: string): Promise<Uint8Array>;

  /** Creates missing folders. The way to hand a secret to a sandbox that is already awake. */
  writeFile(id: string, path: string, content: Uint8Array | string): Promise<void>;

  /**
   * The public address of a port. It stays the same across sleep and wake, but can only be
   * asked for while the sandbox is awake, so keep what `create` returned.
   */
  address(id: string, port: number): Promise<SandboxAddress>;

  /**
   * Starts saving the sandbox's disk under `name` (lowercase letters, digits and dashes) and
   * returns while it is `saving`: poll `getSnapshot`. Saving over a name replaces it once the
   * new one is ready. A snapshot outlives its sandbox.
   */
  saveSnapshot(id: string, name: string): Promise<Snapshot>;

  getSnapshot(name: string): Promise<Snapshot | null>;

  listSnapshots(): Promise<Snapshot[]>;

  /** Fine to repeat. Sandboxes already created from it are not affected. */
  deleteSnapshot(name: string): Promise<void>;

  /** The provider's own meter. It cannot be read after `destroy`. */
  usage(id: string): Promise<Usage>;
}

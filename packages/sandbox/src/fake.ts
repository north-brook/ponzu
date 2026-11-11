/*
 * Sandboxes in memory, modelling Vercel as the live suite recorded it, for testing the API's
 * lifecycle without a network:
 *
 * - names are unique;
 * - up() on a stopped sandbox starts a new session: files kept (persistent), processes and
 *   their commands gone;
 * - up() on a running sandbox returns that session with wasRunning;
 * - a session stops by itself at its deadline;
 * - a pinned call on any other session, or on one that stopped, is not_running;
 * - an image digest change empties the disk and counts as a recreate;
 * - config drift is recorded as an update, applying from the next session;
 * - it counts the sessions started (resumes).
 *
 * Time is a FakeClock: the options say how long creates, resumes and stops take.
 */

import type { FakeClock } from "./clock.ts";
import { SandboxError, type SandboxErrorCode } from "./errors.ts";
import {
  type At,
  type CallOptions,
  type Command,
  type ExecResult,
  imageDigest,
  type Sandboxes,
  type SandboxInfo,
  type SandboxSpec,
  type Up,
  type VercelStatus,
} from "./sandboxes.ts";

export interface FakeOptions {
  stopMs?: number;
  resumeMs?: number;
  createMs?: number;
}

/** Vercel's plan cap on one session (Pro): extending past it is refused. */
const MAX_SESSION_MS = 24 * 3600_000;

type Config = Omit<SandboxSpec, "image">;
type Files = Map<string, Uint8Array>;

interface FakeSession {
  id: string;
  startedAt: number;
  timeoutMs: number;
  status: "running" | "stopped" | "failed";
  /** Booted from a snapshot (false: an empty disk). */
  fromSnapshot: boolean;
}

interface Box {
  name: string;
  image: string;
  config: Config;
  updates: number;
  createdAt: number;
  session: FakeSession;
  /** The disk as the running session sees it, or as the last stop left it. */
  files: Files;
  /** Snapshots, newest last: what a resume boots from. */
  snapshots: Files[];
}

interface Recorded {
  sessionId: string;
  kind: "start" | "exec";
  command: Command;
}

const encoder = new TextEncoder();
const copy = (files: Files): Files => new Map(files);

export class FakeSandboxes implements Sandboxes {
  readonly #clock: FakeClock;
  readonly #options: Required<FakeOptions>;
  readonly #boxes = new Map<string, Box>();
  /** Command history per name, kept across sessions and removals. */
  readonly #commands = new Map<string, Recorded[]>();
  /** Resumes per name, kept across removals (a recreate counts on). */
  readonly #resumes = new Map<string, number>();
  readonly #failures: Array<{
    op: keyof Sandboxes;
    name: string;
    code: SandboxErrorCode;
    retryAfterSeconds?: number;
  }> = [];
  readonly #handlers = new Map<string, (command: Command) => ExecResult>();
  #ids = 0;

  constructor(clock: FakeClock, options: FakeOptions = {}) {
    this.#clock = clock;
    this.#options = {
      stopMs: options.stopMs ?? 2_500,
      resumeMs: options.resumeMs ?? 1_500,
      createMs: options.createMs ?? 1_000,
    };
  }

  // ── Sandboxes

  async up(name: string, spec: SandboxSpec, _options?: CallOptions): Promise<Up> {
    this.#fail("up", name);
    let box = this.#box(name);
    let recreated = false;
    let wasRunning = false;
    const { image, ...config } = spec;
    if (!box) {
      box = this.#create(name, spec);
    } else if (imageDigest(box.image) !== imageDigest(image)) {
      this.#boxes.delete(name);
      box = this.#create(name, spec);
      recreated = true;
    } else {
      if (drifted(box.config, config)) {
        box.config = { ...config };
        box.updates++;
      }
      if (box.session.status === "running") {
        wasRunning = true;
      } else {
        this.#resume(box);
      }
    }
    const session = box.session;
    const urls: Record<number, string> = {};
    for (const port of spec.ports) urls[port] = `https://${name}-${port}.fake.vercel.run`;
    return {
      name,
      sessionId: session.id,
      startedAt: session.startedAt,
      expiresAt: session.startedAt + session.timeoutMs,
      image: box.image,
      urls,
      fresh: !session.fromSnapshot,
      recreated,
      wasRunning,
    };
  }

  async status(name: string, _options?: CallOptions): Promise<SandboxInfo | null> {
    this.#fail("status", name);
    const box = this.#box(name);
    return box ? info(box) : null;
  }

  async list(prefix: string, _options?: CallOptions): Promise<SandboxInfo[]> {
    this.#fail("list", prefix);
    return [...this.#boxes.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => info(this.#box(name)!));
  }

  async start(at: At, command: Command, _options?: CallOptions): Promise<{ commandId: string }> {
    this.#fail("start", at.name);
    this.#running(at);
    this.#record(at, "start", command);
    return { commandId: `cmd_${++this.#ids}` };
  }

  async exec(
    at: At,
    command: Command & { timeoutMs: number },
    _options?: CallOptions,
  ): Promise<ExecResult> {
    this.#fail("exec", at.name);
    this.#running(at);
    const { timeoutMs: _timeout, ...rest } = command;
    this.#record(at, "exec", rest);
    const handler = this.#handlers.get(command.cmd);
    return handler ? handler(rest) : { exitCode: 0, stdout: "", stderr: "" };
  }

  async writeFile(
    at: At,
    path: string,
    content: string | Uint8Array,
    _options?: CallOptions & { mode?: number },
  ): Promise<void> {
    this.#fail("writeFile", at.name);
    const box = this.#running(at);
    box.files.set(path, typeof content === "string" ? encoder.encode(content) : content.slice());
  }

  async readFile(at: At, path: string, _options?: CallOptions): Promise<Uint8Array | null> {
    this.#fail("readFile", at.name);
    const box = this.#running(at);
    return box.files.get(path)?.slice() ?? null;
  }

  async extend(at: At, ms: number, _options?: CallOptions): Promise<number | null> {
    this.#fail("extend", at.name);
    const box = this.#box(at.name);
    if (!box || box.session.id !== at.sessionId || box.session.status !== "running") return null;
    if (box.session.timeoutMs + ms > MAX_SESSION_MS) {
      // Recorded: 400 sandbox_timeout_invalid, "extension would exceed maximum execution timeout".
      throw new SandboxError("rejected", "extend: 400 sandbox_timeout_invalid");
    }
    box.session.timeoutMs += ms;
    return box.session.startedAt + box.session.timeoutMs;
  }

  async stop(at: At, _options?: CallOptions) {
    this.#fail("stop", at.name);
    const box = this.#box(at.name);
    if (!box || box.session.id !== at.sessionId || box.session.status !== "running") {
      return { stopped: false, snapshotBytes: null };
    }
    this.#clock.advance(this.#options.stopMs);
    return { stopped: true, snapshotBytes: this.#halt(box) };
  }

  async remove(name: string, _options?: CallOptions): Promise<void> {
    this.#fail("remove", name);
    this.#boxes.delete(name);
  }

  // ── test controls

  commands(name: string): { sessionId: string; kind: "start" | "exec"; command: Command }[] {
    return (this.#commands.get(name) ?? []).map((each) => ({ ...each }));
  }

  files(name: string): ReadonlyMap<string, Uint8Array> {
    return copy(this.#box(name)?.files ?? new Map());
  }

  /** The config the sandbox holds and every update() applied to it. */
  config(name: string): { spec: Omit<SandboxSpec, "image">; image: string; updates: number } {
    const box = this.#box(name);
    if (!box) throw new Error(`no sandbox ${name}`);
    return { spec: { ...box.config }, image: box.image, updates: box.updates };
  }

  /** Sessions up() (or resumeBehindOurBack) started on `name`: creates do not count. */
  resumes(name: string): number {
    return this.#resumes.get(name) ?? 0;
  }

  /** Abrupt host loss: the session fails; the next up() boots the files from the stop before the last. */
  lose(name: string): void {
    const box = this.#box(name);
    if (!box) return;
    box.session.status = "failed";
    box.snapshots.pop();
    box.files = copy(box.snapshots.at(-1) ?? new Map());
  }

  /** Snapshot expired: next up() is a fresh disk under the same name. */
  expire(name: string): void {
    const box = this.#box(name);
    if (!box) return;
    box.snapshots = [];
    if (box.session.status !== "running") box.files = new Map();
  }

  /** Vercel removed it after 14 idle days: next up() sees 404 and creates (fresh). */
  retain(name: string): void {
    this.#boxes.delete(name);
  }

  /** A session starts without our asking. */
  resumeBehindOurBack(name: string): void {
    const box = this.#box(name);
    if (box && box.session.status !== "running") this.#resume(box);
  }

  failNext(
    op: keyof Sandboxes,
    name: string,
    code: SandboxErrorCode,
    retryAfterSeconds?: number,
  ): void {
    this.#failures.push({
      op,
      name,
      code,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }

  onExec(cmd: string, handler: (command: Command) => ExecResult): void {
    this.#handlers.set(cmd, handler);
  }

  // ── the model

  /** The box, with its session stopped if its deadline has passed. */
  #box(name: string): Box | undefined {
    const box = this.#boxes.get(name);
    if (
      box &&
      box.session.status === "running" &&
      this.#clock.now() >= box.session.startedAt + box.session.timeoutMs
    ) {
      this.#halt(box);
    }
    return box;
  }

  #create(name: string, spec: SandboxSpec): Box {
    this.#clock.advance(this.#options.createMs);
    const { image, ...config } = spec;
    const box: Box = {
      name,
      image: fullImage(image),
      config: { ...config },
      updates: 0,
      createdAt: this.#clock.now(),
      session: this.#session(config, false),
      files: new Map(),
      snapshots: [],
    };
    this.#boxes.set(name, box);
    return box;
  }

  #resume(box: Box): void {
    this.#clock.advance(this.#options.resumeMs);
    const snapshot = box.config.persistent ? box.snapshots.at(-1) : undefined;
    box.files = snapshot ? copy(snapshot) : new Map();
    box.session = this.#session(box.config, snapshot !== undefined);
    this.#resumes.set(box.name, (this.#resumes.get(box.name) ?? 0) + 1);
  }

  #session(config: Config, fromSnapshot: boolean): FakeSession {
    return {
      id: `sbx_fake${++this.#ids}`,
      startedAt: this.#clock.now(),
      timeoutMs: config.timeoutMs,
      status: "running",
      fromSnapshot,
    };
  }

  /** Stops the running session; a persistent one leaves a snapshot (one kept). */
  #halt(box: Box): number | null {
    box.session.status = "stopped";
    if (!box.config.persistent) {
      box.files = new Map();
      return null;
    }
    // keepLastSnapshots { count: 1 } keeps one; lose() needs the one before, so keep two here.
    box.snapshots = [...box.snapshots.slice(-1), copy(box.files)];
    let bytes = 0;
    for (const content of box.files.values()) bytes += content.byteLength;
    return bytes;
  }

  #running(at: At): Box {
    const box = this.#box(at.name);
    if (!box) throw new SandboxError("not_running", `${at.name} does not exist`);
    if (box.session.id !== at.sessionId) {
      throw new SandboxError("not_running", `${at.sessionId} is not ${at.name}'s current session`);
    }
    if (box.session.status !== "running") {
      throw new SandboxError("not_running", `${at.sessionId} is ${box.session.status}`);
    }
    return box;
  }

  #record(at: At, kind: "start" | "exec", command: Command): void {
    const list = this.#commands.get(at.name) ?? [];
    list.push({ sessionId: at.sessionId, kind, command: structuredClone(command) });
    this.#commands.set(at.name, list);
  }

  #fail(op: keyof Sandboxes, name: string): void {
    const index = this.#failures.findIndex((each) => each.op === op && each.name === name);
    if (index < 0) return;
    const [failure] = this.#failures.splice(index, 1);
    throw new SandboxError(failure!.code, `fake ${op} failed as ${failure!.code}`, {
      ...(failure!.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure!.retryAfterSeconds }),
    });
  }
}

function drifted(held: Config, wanted: Config): boolean {
  return (
    held.persistent !== wanted.persistent ||
    held.timeoutMs !== wanted.timeoutMs ||
    (held.vcpus ?? 2) !== (wanted.vcpus ?? 2) ||
    [...held.ports].sort().join(",") !== [...wanted.ports].sort().join(",") ||
    (wanted.snapshotExpirationMs !== undefined &&
      held.snapshotExpirationMs !== wanted.snapshotExpirationMs)
  );
}

/** Vercel reports the image as "{team}/{project}/{repository}@{digest}". */
function fullImage(image: string): string {
  return image.includes("/") ? image : `fake-team/fake-project/${image}`;
}

function info(box: Box): SandboxInfo {
  const status: VercelStatus = box.session.status;
  return {
    name: box.name,
    status,
    sessionId: box.session.id,
    image: box.image,
    createdAt: box.createdAt,
  };
}

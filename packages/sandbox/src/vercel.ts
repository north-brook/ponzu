/*
 * Sandboxes on Vercel, through @vercel/sandbox 3.9.1 (pinned exactly).
 *
 * The rule: only `up()` resumes. The SDK resumes a stopped persistent sandbox on any Sandbox
 * method that needs a session (runCommand, fs, readFile, writeFiles, extendTimeout, snapshot,
 * updateNetworkPolicy, …: `withResume` in sandbox.js). So past `up()` this file touches only
 * Session methods, which call /v2/sandboxes/sessions/{id}/… and never resume. surface.test.ts
 * holds this file to that: on a Sandbox it may use the static get/create/getOrCreate/list, the
 * getters, currentSession(), update(), delete() and domain(), nothing else.
 *
 * Naming, which surface.test.ts also relies on: a Sandbox value is always `sandbox`, a Session
 * value is always `session`.
 */

import { APIError, Sandbox, type Session, StreamError } from "@vercel/sandbox";
import type { Clock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
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
  type VercelCredentials,
} from "./sandboxes.ts";

/** Every design and check runs in Washington, next to the API's functions. */
const REGION = "iad1";
const DEFAULT_VCPUS = 2;
const KEEP_LAST_SNAPSHOTS = { count: 1, deleteEvicted: true } as const;

/**
 * What "held for a moment" looks like from up() (vercel.test.ts has the live run). A create on a
 * name in use (two wakes racing past the database) answers 400 with the generic code bad_request,
 * told apart only by its message ("A sandbox with the name '…' already exists for this project").
 * image_not_ready is the code the images docs name; the live run could not produce it (an image
 * pushed a second earlier, 400 MB, created at once), so it is matched by code alone, unrecorded.
 */
const IMAGE_NOT_READY = "image_not_ready";
const BUSY_RETRY_SECONDS = 5;

type Pinned = "start" | "exec" | "writeFile" | "readFile" | "extend" | "stop";
type Op = "up" | "status" | "list" | "remove" | Pinned;

export interface VercelSandboxesOptions {
  /** Kept in the contract for callers; the SDK keeps its own time for retries. */
  clock: Clock;
  /** All three or none. None: OIDC (inside a request, or work kept by one). */
  credentials?: VercelCredentials;
  /** Tests and the live suite's recorder. The SDK wraps it in its own retries. */
  fetch?: typeof globalThis.fetch;
}

export function vercelSandboxes(options: VercelSandboxesOptions): Sandboxes {
  return new VercelSandboxes(options);
}

class VercelSandboxes implements Sandboxes {
  readonly #auth: Partial<VercelCredentials> & { fetch?: typeof globalThis.fetch };
  /** The handle `up()` returned, per name: pinned calls on its session skip the lookup. */
  readonly #handles = new Map<string, Sandbox>();

  constructor(options: VercelSandboxesOptions) {
    const credentials = options.credentials;
    if (credentials && !(credentials.token && credentials.teamId && credentials.projectId)) {
      throw new Error("Vercel credentials need all of token, teamId and projectId, or none");
    }
    this.#auth = {
      ...(credentials
        ? {
            token: credentials.token,
            teamId: credentials.teamId,
            projectId: credentials.projectId,
          }
        : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
  }

  async up(name: string, spec: SandboxSpec, options: CallOptions = {}): Promise<Up> {
    return this.#mapped("up", async () => {
      const signal = options.signal;
      let sandbox = await this.#get(name, signal);
      let recreated = false;
      let wasRunning = false;

      if (!sandbox) {
        sandbox = await this.#create(name, spec, signal);
      } else if (imageDigest(sandbox.image) !== imageDigest(spec.image)) {
        // update() has no image: only a new sandbox moves to a new image. Never boot the old one.
        await sandbox.delete({ deleteOrphanSnapshots: true, signal });
        this.#handles.delete(name);
        sandbox = await this.#create(name, spec, signal);
        recreated = true;
      } else {
        const drift = driftOf(sandbox, spec);
        // The docs: creation parameters are ignored for an existing name; update() applies them
        // to the next session and never resumes.
        if (drift) await sandbox.update(drift, { signal });
        if (sandbox.status === "running") {
          wasRunning = true;
        } else {
          let resumed = false;
          let created = false;
          sandbox = await Sandbox.getOrCreate({
            ...this.#createParams(name, spec, signal),
            resume: true,
            onResume: async () => {
              resumed = true;
            },
            onCreate: async () => {
              created = true;
            },
          });
          // Neither hook fired: it was already running when the resume reached it.
          wasRunning = !resumed && !created;
        }
      }

      this.#handles.set(name, sandbox);
      const session = sandbox.currentSession();
      const startedAt = startOf(session);
      const urls: Record<number, string> = {};
      for (const port of spec.ports) urls[port] = sandbox.domain(port);
      return {
        name,
        sessionId: session.sessionId,
        startedAt,
        expiresAt: startedAt + session.timeout,
        image: sandbox.image ?? spec.image,
        urls,
        fresh: !session.sourceSnapshotId,
        recreated,
        wasRunning,
      };
    });
  }

  async status(name: string, options: CallOptions = {}): Promise<SandboxInfo | null> {
    return this.#mapped("status", async () => {
      const sandbox = await this.#get(name, options.signal);
      if (!sandbox) return null;
      const session = sandbox.currentSession();
      return {
        name: sandbox.name,
        status: sandbox.status,
        sessionId: session.sessionId,
        image: sandbox.image ?? null,
        createdAt: sandbox.createdAt.getTime(),
      };
    });
  }

  async list(prefix: string, options: CallOptions = {}): Promise<SandboxInfo[]> {
    return this.#mapped("list", async () => {
      const pages = await Sandbox.list({
        ...this.#auth,
        namePrefix: prefix,
        sortBy: "name",
        signal: options.signal,
      });
      const all = await pages.toArray();
      return all.map((sandbox) => ({
        name: sandbox.name,
        status: sandbox.status,
        sessionId: sandbox.currentSessionId ?? null,
        image: sandbox.image ?? null,
        createdAt: sandbox.createdAt,
      }));
    });
  }

  async start(at: At, command: Command, options: CallOptions = {}) {
    return this.#mapped("start", async () => {
      const session = await this.#session(at, options.signal);
      const started = await session.runCommand({
        cmd: command.cmd,
        args: command.args ?? [],
        env: command.env,
        sudo: command.sudo,
        cwd: command.cwd,
        detached: true,
        signal: options.signal,
      });
      return { commandId: started.cmdId };
    });
  }

  async exec(
    at: At,
    command: Command & { timeoutMs: number },
    options: CallOptions = {},
  ): Promise<ExecResult> {
    return this.#mapped("exec", async () => {
      const session = await this.#session(at, options.signal);
      try {
        const finished = await session.runCommand({
          cmd: command.cmd,
          args: command.args ?? [],
          env: command.env,
          sudo: command.sudo,
          cwd: command.cwd,
          timeoutMs: command.timeoutMs,
          signal: options.signal,
        });
        return {
          exitCode: finished.exitCode,
          stdout: await finished.stdout(),
          stderr: await finished.stderr(),
        };
      } catch (error) {
        if (error instanceof APIError || error instanceof SandboxError) throw error;
        // A broken stream: "typically occurs when the sandbox is stopped while streaming". Only
        // a fresh look tells a session that ended from a connection that dropped.
        if (await this.#stillRunning(at, options.signal)) {
          throw new SandboxError("unavailable", `the command stream broke: ${describe(error)}`, {
            cause: error,
          });
        }
        throw new SandboxError("not_running", `${at.sessionId} ended during the command`, {
          cause: error,
        });
      }
    });
  }

  async writeFile(
    at: At,
    path: string,
    content: string | Uint8Array,
    options: CallOptions & { mode?: number } = {},
  ): Promise<void> {
    return this.#mapped("writeFile", async () => {
      const session = await this.#session(at, options.signal);
      await session.writeFiles(
        [{ path, content, ...(options.mode === undefined ? {} : { mode: options.mode }) }],
        { signal: options.signal },
      );
    });
  }

  async readFile(at: At, path: string, options: CallOptions = {}): Promise<Uint8Array | null> {
    return this.#mapped("readFile", async () => {
      const session = await this.#session(at, options.signal);
      const buffer = await session.readFileToBuffer({ path }, { signal: options.signal });
      return buffer === null ? null : new Uint8Array(buffer);
    });
  }

  async extend(at: At, ms: number, options: CallOptions = {}): Promise<number | null> {
    try {
      return await this.#mapped("extend", async () => {
        const session = await this.#session(at, options.signal);
        // Returns void; the SDK replaces the session from the response, so read it back.
        await session.extendTimeout(ms, { signal: options.signal });
        return startOf(session) + session.timeout;
      });
    } catch (error) {
      if (error instanceof SandboxError && error.code === "not_running") return null;
      throw error;
    }
  }

  async stop(at: At, options: CallOptions = {}) {
    try {
      return await this.#mapped("stop", async () => {
        // Always a fresh look: a stop on a session that already stopped answers 200 with the
        // old snapshot (recorded live), so the held handle cannot tell us it was not running.
        const session = await this.#session(at, options.signal, { fresh: true });
        const stopped = await session.stop({ signal: options.signal });
        return { stopped: true, snapshotBytes: stopped.snapshot?.sizeBytes ?? null };
      });
    } catch (error) {
      if (error instanceof SandboxError && error.code === "not_running") {
        return { stopped: false, snapshotBytes: null };
      }
      throw error;
    }
  }

  async remove(name: string, options: CallOptions = {}): Promise<void> {
    return this.#mapped("remove", async () => {
      this.#handles.delete(name);
      const sandbox = await this.#get(name, options.signal);
      if (!sandbox) return;
      try {
        await sandbox.delete({ deleteOrphanSnapshots: true, signal: options.signal });
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    });
  }

  /** get({resume:false}): reads a stopped sandbox without waking it. Null on 404. */
  async #get(name: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      return await Sandbox.get({ ...this.#auth, name, resume: false, signal });
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  /**
   * The session `at` names, if it is the current one. The handle from up() when it still
   * holds that session; otherwise one get({resume:false}), and not_running without calling
   * anything when the session there is another one or is not running.
   */
  async #session(
    at: At,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<Session> {
    const held = options.fresh ? undefined : this.#handles.get(at.name);
    if (held && held.currentSession().sessionId === at.sessionId) return held.currentSession();
    const sandbox = await this.#get(at.name, signal);
    if (!sandbox) throw new SandboxError("not_running", `${at.name} does not exist`);
    const session = sandbox.currentSession();
    if (session.sessionId !== at.sessionId) {
      throw new SandboxError("not_running", `${at.sessionId} is not ${at.name}'s current session`);
    }
    if (session.status !== "running") {
      throw new SandboxError("not_running", `${at.sessionId} is ${session.status}`);
    }
    this.#handles.set(at.name, sandbox);
    return session;
  }

  async #stillRunning(at: At, signal?: AbortSignal): Promise<boolean> {
    try {
      const sandbox = await this.#get(at.name, signal);
      if (!sandbox) return false;
      const session = sandbox.currentSession();
      return session.sessionId === at.sessionId && session.status === "running";
    } catch {
      // Cannot tell: say unavailable, which promises nothing.
      return true;
    }
  }

  #createParams(name: string, spec: SandboxSpec, signal?: AbortSignal) {
    return {
      ...this.#auth,
      name,
      image: spec.image,
      persistent: spec.persistent,
      ports: spec.ports,
      timeout: spec.timeoutMs,
      resources: { vcpus: spec.vcpus ?? DEFAULT_VCPUS },
      region: REGION,
      // Never a create-level env: the types call it "inherited by all commands", and fork copies it.
      ...(spec.persistent
        ? {
            ...(spec.snapshotExpirationMs === undefined
              ? {}
              : { snapshotExpiration: spec.snapshotExpirationMs }),
            keepLastSnapshots: { ...KEEP_LAST_SNAPSHOTS },
          }
        : {}),
      signal,
    };
  }

  /** Sandbox.create. A deleted name is free at once (recorded live), so no wait follows a delete. */
  async #create(name: string, spec: SandboxSpec, signal?: AbortSignal): Promise<Sandbox> {
    return Sandbox.create(this.#createParams(name, spec, signal));
  }

  async #mapped<T>(op: Op, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toSandboxError(op, error);
    }
  }
}

/** What differs between the sandbox's stored configuration and the spec, as update() fields. */
function driftOf(sandbox: Sandbox, spec: SandboxSpec): Parameters<Sandbox["update"]>[0] | null {
  const drift: Parameters<Sandbox["update"]>[0] = {};
  if (sandbox.persistent !== spec.persistent) drift.persistent = spec.persistent;
  if (sandbox.timeout !== spec.timeoutMs) drift.timeout = spec.timeoutMs;
  const vcpus = spec.vcpus ?? DEFAULT_VCPUS;
  if (sandbox.vcpus !== vcpus) drift.resources = { vcpus };
  // A resumed session also routes Vercel's own interactive port (recorded live, "system": true,
  // which the SDK's validator strips): it is not ours, and update({ports}) would drop it.
  const interactive = sandbox.currentSession().interactivePort;
  const ports = sandbox.routes
    .map((route) => route.port)
    .filter((port) => port !== interactive)
    .sort((a, b) => a - b);
  const wanted = [...spec.ports].sort((a, b) => a - b);
  if (ports.join(",") !== wanted.join(",")) drift.ports = spec.ports;
  if (spec.persistent) {
    if (
      spec.snapshotExpirationMs !== undefined &&
      sandbox.snapshotExpiration !== spec.snapshotExpirationMs
    ) {
      drift.snapshotExpiration = spec.snapshotExpirationMs;
    }
    const keep = sandbox.keepLastSnapshots;
    if (keep?.count !== KEEP_LAST_SNAPSHOTS.count || keep.deleteEvicted === false) {
      drift.keepLastSnapshots = { ...KEEP_LAST_SNAPSHOTS };
    }
  }
  return Object.keys(drift).length > 0 ? drift : null;
}

function startOf(session: Session): number {
  return (session.startedAt ?? session.createdAt).getTime();
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const json = error.json as { error?: { code?: unknown } } | undefined;
  return typeof json?.error?.code === "string" ? json.error.code : undefined;
}

function isNameTaken(error: unknown): boolean {
  if (!(error instanceof APIError) || error.response.status !== 400) return false;
  const json = error.json as { error?: { code?: unknown; message?: unknown } } | undefined;
  const message = json?.error?.message;
  return (
    json?.error?.code === "bad_request" &&
    typeof message === "string" &&
    /already exists/i.test(message)
  );
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof APIError && error.response.status === status;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PINNED: ReadonlySet<Op> = new Set<Op>([
  "start",
  "exec",
  "writeFile",
  "readFile",
  "extend",
  "stop",
]);

/** The error table of the design, section 2. */
export function toSandboxError(op: Op, error: unknown): SandboxError {
  if (error instanceof SandboxError) return error;
  if (error instanceof APIError) {
    const status: number = error.response.status;
    const code = errorCode(error);
    const what = `${op}: ${status}${code ? ` ${code}` : ""}: ${error.message}`;
    if (status === 429) {
      const header = Number(error.response.headers.get("Retry-After"));
      return new SandboxError("rate_limited", what, {
        cause: error,
        ...(Number.isFinite(header) && header > 0 ? { retryAfterSeconds: header } : {}),
      });
    }
    if (op === "up" && (code === IMAGE_NOT_READY || isNameTaken(error))) {
      return new SandboxError("busy", what, {
        cause: error,
        retryAfterSeconds: BUSY_RETRY_SECONDS,
      });
    }
    if (
      PINNED.has(op) &&
      (status === 410 ||
        (status === 422 && (code === "sandbox_stopping" || code === "sandbox_snapshotting")))
    ) {
      return new SandboxError("not_running", what, { cause: error });
    }
    // 5xx after the SDK's retries, or a 2xx body the SDK could not read.
    if (status >= 500 || status < 400)
      return new SandboxError("unavailable", what, { cause: error });
    return new SandboxError("rejected", what, { cause: error });
  }
  if (error instanceof StreamError) {
    return new SandboxError("unavailable", `${op}: stream ${error.code}: ${error.message}`, {
      cause: error,
    });
  }
  return new SandboxError("unavailable", `${op}: ${describe(error)}`, { cause: error });
}

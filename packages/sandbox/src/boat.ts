/*
 * boat.dev as a SandboxProvider, on plain fetch. Each sandbox is a full VM; the API is JSON
 * over HTTPS with an organization key as the bearer token.
 *
 * boat's words for ours: a sandbox that is asleep is `archived`, the auto-stop deadline is
 * `archiveAfter`, a base snapshot is a "saved snapshot", and `medium` is its `default` size.
 */

import { type Clock, poll, systemClock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import { ndjson } from "./ndjson.ts";
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
  SandboxState,
  Snapshot,
  Usage,
  Wake,
  WakeOptions,
} from "./provider.ts";
import { ensureAwake } from "./wake.ts";

/** The part of `fetch` this uses, so a test can pass a plain function. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BoatOptions {
  /** An organization key. It is sent only as the bearer token, never in a URL or a body. */
  apiKey: string;
  fetch?: Fetch;
  clock?: Clock;
  baseUrl?: string;
}

const BASE_URL = "https://boat.dev/api/v1";

const SIZE: Record<SandboxSize, string> = {
  small: "small",
  medium: "default",
  large: "large",
  xlarge: "xlarge",
};

const STATE: Record<string, SandboxState> = {
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  ready: "awake",
  // `idle` and `running` only say whether boat's own agent is busy, which Ponzu does not use.
  idle: "awake",
  running: "awake",
  archiving: "stopping",
  archived: "asleep",
  // Lost contact or a failed start. Not billed, and a resume restores it from its last save.
  error: "asleep",
  // A create that never got a machine. boat reports it once, then answers 404.
  cancelled: "gone",
};

/**
 * A create holds its answer until the machine exists so it can return the port addresses: up to
 * 60 s. This bounds the whole call, re-sends included.
 */
const CREATE_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** A command or file call sent during a start is held by boat for up to 60 s before it answers. */
const HELD_WHILE_STARTING_MS = 75_000;
const DEFAULT_COMMAND_SECONDS = 30;
/**
 * How long to keep re-sending a call boat refused because the sandbox's disk was still being
 * mounted, counted from the first refusal. boat says to try again after 1 to 3 s.
 */
const RESTORING_RETRY_MS = 30_000;
const RESTORING_RETRY_EVERY_MS = 1_000;
/** How long boat gets to finish a delete it accepted. */
const DESTROY_TIMEOUT_MS = 60_000;
const PROCESS_TAIL_BYTES = 64 * 1024;
const PAGE = 200;
/** Used only if a 429 arrives without the Retry-After boat promises: the shortest start window. */
const RATE_LIMIT_FALLBACK_SECONDS = 60;
/** Used when boat says to wait for something to finish without saying how long. */
const BUSY_FALLBACK_SECONDS = 2;

interface BoatSandbox {
  id: string;
  state: string;
  labels?: Record<string, string>;
  archiveAfter?: string | null;
  error?: string | null;
}

interface BoatHostedPort {
  port: number;
  url?: string;
}

interface BoatSnapshot {
  name: string;
  status: "saving" | "ready" | "failed";
  sourceSandboxId: string;
  sizeBytes?: number;
  createdAt: string;
  error?: string;
}

interface BoatCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

type BoatStreamFrame =
  | { type: "started" }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number | null; timedOut: boolean }
  | { type: "error"; error?: string; message?: string; retryable?: boolean };

interface BoatErrorBody {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  retryAfter?: number;
}

interface Call {
  body?: unknown;
  headers?: Record<string, string>;
  /** How long boat gets to answer one send. Defaults to 30 s. */
  timeoutMs?: number;
  /** When the call must be over, re-sends included, on the provider's clock. */
  deadline?: number | undefined;
  /**
   * Asked when boat refuses because the sandbox's disk is still being mounted: resolves true,
   * after a pause, if the call should be sent again.
   */
  again?: () => Promise<boolean>;
}

export class BoatProvider implements SandboxProvider {
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #clock: Clock;
  readonly #baseUrl: string;

  constructor(options: BoatOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#baseUrl = options.baseUrl ?? BASE_URL;
  }

  async create(options: CreateOptions): Promise<Created> {
    const deadline = this.#clock.now() + CREATE_TIMEOUT_MS;
    const call: Call = {
      headers: { "Idempotency-Key": options.idempotencyKey },
      timeoutMs: CREATE_TIMEOUT_MS,
      deadline,
      body: {
        ...(options.from ? { from: options.from } : {}),
        type: SIZE[options.size ?? "small"],
        // Keeps the boat account's own secrets and logins off the machine and confines its
        // built-in token to this one sandbox. Every Ponzu sandbox runs someone else's code.
        noEnv: true,
        ttlSeconds: options.autoStopSeconds,
        ...(options.name ? { name: options.name } : {}),
        // A retry must match the first request's body, so the same options always make the
        // same body, whatever order the caller built them in.
        ...(options.labels ? { labels: byKey(options.labels) } : {}),
        ...(options.env ? { env: byKey(options.env) } : {}),
        ...(options.ports ? { hostedPorts: options.ports.map((port) => ({ port })) } : {}),
      },
    };
    for (;;) {
      try {
        const { body } = await this.#json<{
          sandbox: BoatSandbox;
          hostedPorts?: BoatHostedPort[];
        }>("POST", "/sandboxes", call);
        return {
          sandbox: toSandbox(body.sandbox),
          addresses: (body.hostedPorts ?? []).flatMap((hosted) =>
            hosted.url ? [toAddress(hosted.port, hosted.url)] : [],
          ),
        };
      } catch (error) {
        // boat is still making the sandbox for an earlier send of this create, one the caller
        // gave up on. It has not made a second: ask again until it hands over the first.
        if (!isCode(error, "busy")) throw error;
        const wait = Math.max(1, error.retryAfterSeconds ?? BUSY_FALLBACK_SECONDS) * 1000;
        if (this.#clock.now() + wait >= deadline) throw error;
        await this.#clock.sleep(wait);
      }
    }
  }

  get(id: string): Promise<Sandbox> {
    return this.#get(id);
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Sandbox[]> {
    const found: Sandbox[] = [];
    for (let cursor: string | null = null; ; ) {
      const query = new URLSearchParams({ limit: String(PAGE) });
      for (const [key, value] of Object.entries(filter.labels ?? {})) {
        query.append("label", `${key}=${value}`);
      }
      if (cursor) query.set("cursor", cursor);
      const { body } = await this.#json<{
        sandboxes: BoatSandbox[];
        pageInfo?: { nextCursor: string | null; hasMore: boolean };
      }>("GET", `/sandboxes?${query}`);
      found.push(...body.sandboxes.map(toSandbox));
      cursor = body.pageInfo?.hasMore ? body.pageInfo.nextCursor : null;
      if (!cursor) return found;
    }
  }

  ensureAwake(id: string, options?: WakeOptions): Promise<Wake> {
    const by = (timeoutMs: number) => this.#clock.now() + timeoutMs;
    return ensureAwake(
      {
        get: (sandbox, timeoutMs) => this.#get(sandbox, by(timeoutMs)),
        resume: (sandbox, resume, timeoutMs) => this.#resume(sandbox, resume, by(timeoutMs)),
        // boat can report `ready` a moment before the machine takes a command.
        probe: async (sandbox, timeoutMs) => {
          await this.#exec(sandbox, "true", { timeoutSeconds: 10 }, by(timeoutMs));
        },
      },
      this.#clock,
      id,
      options,
    );
  }

  resume(id: string, options: ResumeOptions = {}): Promise<Resumed> {
    return this.#resume(id, options);
  }

  async stop(id: string): Promise<Sandbox> {
    const { body } = await this.#json<{ sandbox: BoatSandbox }>("POST", `${sandboxPath(id)}/stop`, {
      body: {},
    });
    return toSandbox(body.sandbox);
  }

  async extend(id: string, seconds: number): Promise<Sandbox> {
    const { body } = await this.#json<{ sandbox: BoatSandbox }>("PATCH", sandboxPath(id), {
      body: { ttlSeconds: seconds },
    });
    return toSandbox(body.sandbox);
  }

  async destroy(id: string): Promise<void> {
    try {
      // The header must repeat the id, or boat refuses with delete_confirmation_required.
      await this.#json("DELETE", sandboxPath(id), { headers: { "X-Ascii-Confirm-Delete": id } });
    } catch (error) {
      if (isCode(error, "not_found")) return;
      throw error;
    }
    // boat deletes in the background and reports progress on an operation that an organization
    // key is not allowed to read. The sandbox answering 404 is the confirmation.
    await poll(this.#clock, DESTROY_TIMEOUT_MS, `sandbox ${id} to be deleted`, async (left) =>
      (await this.#get(id, this.#clock.now() + left())).state === "gone" ? true : undefined,
    );
  }

  exec(id: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.#exec(id, command, options);
  }

  async *execStream(
    id: string,
    command: string,
    options: ExecOptions = {},
  ): AsyncGenerator<ExecEvent> {
    const call = commandCall(command, options);
    const again = this.#whileRestoring();
    for (;;) {
      const response = await this.#send("POST", `${sandboxPath(id)}/commands`, {
        ...call,
        body: { ...call.body, stream: true },
        again,
      });
      if (!response.body) throw new SandboxError("unavailable", "boat sent no command output");
      let output = false;
      let restoring = false;
      try {
        for await (const frame of ndjson<BoatStreamFrame>(response.body)) {
          if (frame.type === "stdout" || frame.type === "stderr") {
            output = true;
            yield { type: frame.type, data: frame.data };
          } else if (frame.type === "exit") {
            yield { type: "exit", exitCode: frame.exitCode, timedOut: frame.timedOut };
            return;
          } else if (frame.type === "error") {
            // A stream is already a 200 when boat finds the disk still being mounted, so that
            // refusal arrives as a frame. `retryable` is boat's word that the command never ran.
            restoring = frame.retryable === true && !output;
            if (restoring) break;
            throw new SandboxError(
              "unavailable",
              `boat could not run the command: ${frame.message ?? frame.error ?? "no reason given"}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        throw new SandboxError("unavailable", "the command's output stream broke", {
          cause: error,
        });
      }
      if (!restoring) {
        throw new SandboxError(
          "unavailable",
          "the command's output ended before its exit; it may still be running",
        );
      }
      if (!(await again())) {
        throw new SandboxError(
          "not_running",
          `sandbox ${id} was still restoring its disk; the command did not run`,
        );
      }
    }
  }

  async spawn(
    id: string,
    command: string,
    options: { cwd?: string } = {},
  ): Promise<{ pid: number }> {
    const { body } = await this.#json<{ processId: number }>(
      "POST",
      `${sandboxPath(id)}/commands`,
      {
        timeoutMs: HELD_WHILE_STARTING_MS,
        body: { command, detached: true, ...(options.cwd ? { cwd: options.cwd } : {}) },
        again: this.#whileRestoring(),
      },
    );
    return { pid: body.processId };
  }

  async process(id: string, pid: number): Promise<ProcessStatus> {
    const { body } = await this.#json<{
      status: ProcessStatus["state"];
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>("GET", `${sandboxPath(id)}/commands/${pid}?tailBytes=${PROCESS_TAIL_BYTES}`, {
      timeoutMs: HELD_WHILE_STARTING_MS,
    });
    return {
      state: body.status,
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
    };
  }

  async kill(id: string, pid: number): Promise<void> {
    // Killing a process that already ended, or never existed, also answers 200.
    await this.#json("DELETE", `${sandboxPath(id)}/commands/${pid}`, {
      timeoutMs: HELD_WHILE_STARTING_MS,
    });
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    const query = new URLSearchParams({ path, encoding: "base64" });
    try {
      const { body } = await this.#json<{ content: string }>(
        "GET",
        `${sandboxPath(id)}/files?${query}`,
        { timeoutMs: HELD_WHILE_STARTING_MS, again: this.#whileRestoring() },
      );
      return new Uint8Array(Buffer.from(body.content, "base64"));
    } catch (error) {
      // boat has no code for a missing file: it passes the machine's own error through as a 400.
      if (isCode(error, "rejected") && error.message.includes("ENOENT")) {
        throw new SandboxError("not_found", `no file ${path} in sandbox ${id}`);
      }
      throw error;
    }
  }

  async writeFile(id: string, path: string, content: Uint8Array | string): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await this.#json("PUT", `${sandboxPath(id)}/files`, {
      timeoutMs: HELD_WHILE_STARTING_MS,
      body: { path, content: bytes.toString("base64"), encoding: "base64" },
      again: this.#whileRestoring(),
    });
  }

  async address(id: string, port: number): Promise<SandboxAddress> {
    // Hosting a port that is already hosted returns the same address and token.
    const { body } = await this.#json<{ url: string }>("POST", `${sandboxPath(id)}/host`, {
      body: { port },
    });
    return toAddress(port, body.url);
  }

  async saveSnapshot(id: string, name: string): Promise<Snapshot> {
    const { body } = await this.#json<{ snapshot: BoatSnapshot }>("POST", "/saved-snapshots", {
      body: { sandboxId: id, name },
    });
    return toSnapshot(body.snapshot);
  }

  async getSnapshot(name: string): Promise<Snapshot | null> {
    try {
      const { body } = await this.#json<{ snapshot: BoatSnapshot }>("GET", snapshotPath(name));
      return toSnapshot(body.snapshot);
    } catch (error) {
      if (isCode(error, "not_found")) return null;
      throw error;
    }
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const { body } = await this.#json<{ snapshots: BoatSnapshot[] }>("GET", "/saved-snapshots");
    return body.snapshots.map(toSnapshot);
  }

  async deleteSnapshot(name: string): Promise<void> {
    try {
      await this.#json("DELETE", snapshotPath(name));
    } catch (error) {
      if (isCode(error, "not_found")) return;
      throw error;
    }
  }

  async usage(id: string): Promise<Usage> {
    const { body } = await this.#json<{
      seconds: number;
      billingMultiplier: number;
      dollars: number;
      running: boolean;
    }>("GET", `${sandboxPath(id)}/usage`);
    return {
      // boat reports billed seconds, already scaled by the size's rate: a small sandbox that
      // was awake for 10 s reads 5.
      awakeSeconds: body.seconds / body.billingMultiplier,
      costUsd: body.dollars,
      awake: body.running,
    };
  }

  async #get(id: string, deadline?: number): Promise<Sandbox> {
    try {
      const { body } = await this.#json<{ sandbox: BoatSandbox }>("GET", sandboxPath(id), {
        deadline,
      });
      return toSandbox(body.sandbox);
    } catch (error) {
      if (isCode(error, "not_found")) return gone(id);
      throw error;
    }
  }

  async #resume(id: string, options: ResumeOptions, deadline?: number): Promise<Resumed> {
    const { body } = await this.#json<{ status: string; sandbox: BoatSandbox }>(
      "POST",
      `${sandboxPath(id)}/resume`,
      {
        deadline,
        body: {
          ...(options.env ? { env: options.env } : {}),
          ...(options.autoStopSeconds === undefined ? {} : { ttlSeconds: options.autoStopSeconds }),
        },
      },
    );
    // A machine that was only frozen, or never stopped, is `running` by the time boat answers
    // (200). A boot answers `resuming` (202) while the machine is still being made.
    const coldStart = body.status !== "running";
    if (options.env && !coldStart) {
      // boat answers 200 and keeps the old values: a new environment always takes a boot.
      throw new SandboxError(
        "conflict",
        `sandbox ${id} is awake, so its environment was not replaced; stop it first`,
      );
    }
    return { sandbox: toSandbox(body.sandbox), coldStart };
  }

  async #exec(
    id: string,
    command: string,
    options: ExecOptions,
    deadline?: number,
  ): Promise<ExecResult> {
    const { body } = await this.#json<BoatCommandResult>("POST", `${sandboxPath(id)}/commands`, {
      ...commandCall(command, options),
      deadline,
      again: this.#whileRestoring(deadline),
    });
    return {
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      timedOut: body.timedOut,
      truncated: Boolean(body.stdoutTruncated || body.stderrTruncated),
    };
  }

  /**
   * The patience for one call that boat refuses because the sandbox's disk is still being
   * mounted, the one refusal it promises never reached the machine: a second's pause and
   * another go, for 30 s. That is counted from the first refusal, not the first send, because
   * boat can hold a call for a minute before it answers.
   */
  #whileRestoring(deadline = Number.POSITIVE_INFINITY): () => Promise<boolean> {
    let until: number | undefined;
    return async () => {
      const now = this.#clock.now();
      until ??= Math.min(now + RESTORING_RETRY_MS, deadline);
      if (now + RESTORING_RETRY_EVERY_MS > until) return false;
      await this.#clock.sleep(RESTORING_RETRY_EVERY_MS);
      return true;
    };
  }

  async #json<T = unknown>(method: string, path: string, call: Call = {}): Promise<{ body: T }> {
    const response = await this.#send(method, path, call);
    try {
      return { body: (await response.json()) as T };
    } catch (error) {
      throw new SandboxError("unavailable", `boat answered ${method} ${bare(path)} unreadably`, {
        cause: error,
      });
    }
  }

  /** One API call. Returns only a successful response; anything else throws a SandboxError. */
  async #send(method: string, path: string, call: Call): Promise<Response> {
    for (;;) {
      const timeoutMs = Math.min(
        call.timeoutMs ?? REQUEST_TIMEOUT_MS,
        (call.deadline ?? Number.POSITIVE_INFINITY) - this.#clock.now(),
      );
      if (timeoutMs <= 0) {
        throw new SandboxError("unavailable", `no time left for ${method} ${bare(path)}`);
      }
      let response: Response;
      try {
        response = await this.#fetch(this.#baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...call.headers,
          },
          ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
          signal: this.#clock.timeout(timeoutMs),
        });
      } catch (error) {
        throw new SandboxError("unavailable", `boat did not answer ${method} ${bare(path)}`, {
          cause: error,
        });
      }
      if (response.ok) return response;

      const body = await errorBody(response);
      if (call.again && stillRestoring(response.status, body) && (await call.again())) continue;
      throw toError(method, path, response, body, this.#clock.now());
    }
  }
}

function sandboxPath(id: string): string {
  return `/sandboxes/${encodeURIComponent(id)}`;
}

function snapshotPath(name: string): string {
  return `/saved-snapshots/${encodeURIComponent(name)}`;
}

/** A path without its query, for messages: a query can carry a file path, and nothing else is needed to find the call. */
function bare(path: string): string {
  return path.split("?")[0]!;
}

function commandCall(
  command: string,
  options: ExecOptions,
): { body: Record<string, unknown>; timeoutMs: number } {
  const seconds = options.timeoutSeconds ?? DEFAULT_COMMAND_SECONDS;
  return {
    body: { command, timeoutSeconds: seconds, ...(options.cwd ? { cwd: options.cwd } : {}) },
    timeoutMs: seconds * 1000 + HELD_WHILE_STARTING_MS,
  };
}

/** The same record with its keys in order. */
function byKey(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function isCode(error: unknown, code: SandboxError["code"]): error is SandboxError {
  return error instanceof SandboxError && error.code === code;
}

function gone(id: string): Sandbox {
  return { id, state: "gone", labels: {}, autoStopAt: null, reason: null };
}

function toSandbox(raw: BoatSandbox): Sandbox {
  // An unknown state is one boat added since: nothing can be assumed to run in it.
  const state = STATE[raw.state] ?? "starting";
  if (state === "gone") return { ...gone(raw.id), reason: raw.error ?? null };
  return {
    id: raw.id,
    state,
    labels: raw.labels ?? {},
    // boat keeps a deadline on a stopped sandbox too, where it means nothing.
    autoStopAt:
      raw.archiveAfter && (state === "awake" || state === "starting")
        ? Date.parse(raw.archiveAfter)
        : null,
    reason: raw.error ?? null,
  };
}

/**
 * boat returns `https://<subdomain>-<port>.on.boat.dev?_token=<secret>`. The token is accepted
 * as that query parameter or as the `_port_auth` cookie the first such request sets; an
 * `Authorization` header is not. Split, so the origin can be logged and the secret kept apart.
 */
function toAddress(port: number, hostedUrl: string): SandboxAddress {
  const url = new URL(hostedUrl);
  const token = url.searchParams.get("_token");
  return {
    port,
    url: url.origin,
    token,
    headers: token ? { Cookie: `_port_auth=${token}` } : {},
    query: token ? { _token: token } : {},
  };
}

function toSnapshot(raw: BoatSnapshot): Snapshot {
  return {
    name: raw.name,
    state: raw.status,
    sandboxId: raw.sourceSandboxId,
    sizeBytes: raw.sizeBytes ?? null,
    createdAt: Date.parse(raw.createdAt),
    error: raw.error ?? null,
  };
}

/** An error's body, or nothing when what answered was not boat's JSON envelope. */
async function errorBody(response: Response): Promise<BoatErrorBody> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null ? body : {};
}

/**
 * The refusal after which boat promises a call never reached the machine: the sandbox was
 * still mounting its disk, in the first seconds of a start.
 */
function stillRestoring(status: number, body: BoatErrorBody): boolean {
  return (
    status === 502 && body.code === "sandbox_direct_failed" && body.message === "sandbox_restoring"
  );
}

/**
 * `sandbox_starting` is boat giving up after holding a call for 60 s while the sandbox
 * started. It is not sent again from here: by then the start is slow enough to be the caller's
 * to judge, and `ensureAwake` asks again inside its own deadline.
 */
const NOT_RUNNING = new Set(["machine_not_running", "sandbox_not_ready", "sandbox_starting"]);
/**
 * 409s that say to wait for something already under way and then send the same call again: a
 * stop that still holds the machine, a resume someone else began, and a create whose first
 * send is still being made.
 */
const BUSY = new Set(["sandbox_stopping", "sandbox_resuming", "idempotency_in_progress"]);
/** 429s that are about how many sandboxes run at once or what the plan allows, not about pace. */
const START_CAP = new Set(["limit_reached", "member_limit_reached", "trial_compute_limit_reached"]);

/** Retry-After in seconds, which is how boat sends it, or as the date HTTP also allows; failing that, the body's own count. */
function retryAfterSeconds(
  response: Response,
  body: BoatErrorBody,
  now: number,
): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  return body.retryAfterSeconds ?? body.retryAfter;
}

function toError(
  method: string,
  path: string,
  response: Response,
  body: BoatErrorBody,
  now: number,
): SandboxError {
  const { status } = response;
  const code = body.code ?? `http_${status}`;
  const message = `boat refused ${method} ${bare(path)}: ${status} ${code}${
    body.message && body.message !== code ? `: ${body.message}` : ""
  }`;
  const wait = retryAfterSeconds(response, body, now);
  const retry = wait === undefined ? {} : { retryAfterSeconds: wait };

  if (status === 404) {
    // Only boat's own word means the thing is gone. Any other 404 is a wrong address or
    // something in between, and says nothing about whether a sandbox still runs.
    return code === "not_found" || code === "snapshot_not_found"
      ? new SandboxError("not_found", message)
      : new SandboxError("unavailable", message);
  }
  if (code === "snapshot_data_expired") return new SandboxError("snapshot_expired", message);
  if (NOT_RUNNING.has(code) || stillRestoring(status, body)) {
    return new SandboxError("not_running", message);
  }
  if (BUSY.has(code)) {
    return new SandboxError("busy", message, {
      retryAfterSeconds: wait ?? BUSY_FALLBACK_SECONDS,
    });
  }
  if (START_CAP.has(code)) return new SandboxError("start_cap_reached", message, retry);
  if (status === 429) {
    return new SandboxError("rate_limited", message, {
      retryAfterSeconds: wait ?? RATE_LIMIT_FALLBACK_SECONDS,
    });
  }
  if (status === 409) return new SandboxError("conflict", message, retry);
  if (status >= 500) return new SandboxError("unavailable", message, retry);
  return new SandboxError("rejected", message);
}

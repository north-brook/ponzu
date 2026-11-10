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

/** A create holds its answer until the machine exists so it can return the port addresses: up to 60 s. */
const CREATE_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** A command or file call sent during a start is held by boat for up to 60 s before it answers. */
const HELD_WHILE_STARTING_MS = 75_000;
const DEFAULT_COMMAND_SECONDS = 30;
/** How long to keep re-sending a call boat refused because the sandbox had not finished starting. */
const NOT_STARTED_RETRY_MS = 30_000;
const NOT_STARTED_RETRY_EVERY_MS = 1_000;
const DESTROY_TIMEOUT_MS = 60_000;
const PROCESS_TAIL_BYTES = 64 * 1024;
const PAGE = 200;
/** Used only if a 429 arrives without the Retry-After boat promises: the shortest start window. */
const RATE_LIMIT_FALLBACK_SECONDS = 60;

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
  | { type: "error"; error?: string; message?: string };

interface BoatErrorBody {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  retryAfter?: number;
}

interface Call {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Re-send while boat refuses because the sandbox has not finished starting. */
  retryNotStarted?: boolean;
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
    const { body } = await this.#json<{ sandbox: BoatSandbox; hostedPorts?: BoatHostedPort[] }>(
      "POST",
      "/sandboxes",
      {
        headers: { "Idempotency-Key": options.idempotencyKey },
        timeoutMs: CREATE_TIMEOUT_MS,
        body: {
          ...(options.from ? { from: options.from } : {}),
          type: SIZE[options.size ?? "small"],
          // Keeps the boat account's own secrets and logins off the machine and confines its
          // built-in token to this one sandbox. Every Ponzu sandbox runs someone else's code.
          noEnv: true,
          ttlSeconds: options.autoStopSeconds,
          ...(options.name ? { name: options.name } : {}),
          ...(options.labels ? { labels: options.labels } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.ports ? { hostedPorts: options.ports.map((port) => ({ port })) } : {}),
        },
      },
    );
    return {
      sandbox: toSandbox(body.sandbox),
      addresses: (body.hostedPorts ?? []).flatMap((hosted) =>
        hosted.url ? [toAddress(hosted.port, hosted.url)] : [],
      ),
    };
  }

  async get(id: string): Promise<Sandbox> {
    try {
      const { body } = await this.#json<{ sandbox: BoatSandbox }>("GET", sandboxPath(id));
      return toSandbox(body.sandbox);
    } catch (error) {
      if (isCode(error, "not_found")) return gone(id);
      throw error;
    }
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
    return ensureAwake(this, this.#clock, id, options, async (awake) => {
      await this.exec(awake, "true", { timeoutSeconds: 10 });
    });
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<Resumed> {
    const { body } = await this.#json<{ status: string; sandbox: BoatSandbox }>(
      "POST",
      `${sandboxPath(id)}/resume`,
      {
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
    await poll(this.#clock, DESTROY_TIMEOUT_MS, `sandbox ${id} to be deleted`, async () =>
      (await this.get(id)).state === "gone" ? true : undefined,
    );
  }

  async exec(id: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { body } = await this.#json<BoatCommandResult>("POST", `${sandboxPath(id)}/commands`, {
      ...commandCall(command, options),
      retryNotStarted: true,
    });
    return {
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      timedOut: body.timedOut,
      truncated: Boolean(body.stdoutTruncated || body.stderrTruncated),
    };
  }

  async *execStream(
    id: string,
    command: string,
    options: ExecOptions = {},
  ): AsyncGenerator<ExecEvent> {
    const call = commandCall(command, options);
    const response = await this.#send("POST", `${sandboxPath(id)}/commands`, {
      ...call,
      body: { ...call.body, stream: true },
      retryNotStarted: true,
    });
    if (!response.body) throw new SandboxError("unavailable", "boat sent no command output");
    try {
      for await (const frame of ndjson<BoatStreamFrame>(response.body)) {
        if (frame.type === "stdout" || frame.type === "stderr") {
          yield { type: frame.type, data: frame.data };
        } else if (frame.type === "exit") {
          yield { type: "exit", exitCode: frame.exitCode, timedOut: frame.timedOut };
          return;
        } else if (frame.type === "error") {
          throw new SandboxError(
            "unavailable",
            `boat could not run the command: ${frame.message ?? frame.error ?? "no reason given"}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("unavailable", "the command's output stream broke", { cause: error });
    }
    throw new SandboxError(
      "unavailable",
      "the command's output ended before its exit; it may still be running",
    );
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
        retryNotStarted: true,
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
        { timeoutMs: HELD_WHILE_STARTING_MS, retryNotStarted: true },
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
      retryNotStarted: true,
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
    const retryUntil = this.#clock.now() + NOT_STARTED_RETRY_MS;
    for (;;) {
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
          signal: AbortSignal.timeout(call.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new SandboxError("unavailable", `boat did not answer ${method} ${bare(path)}`, {
          cause: error,
        });
      }
      if (response.ok) return response;

      const body = (await response.json().catch(() => ({}))) as BoatErrorBody;
      if (
        call.retryNotStarted &&
        neverReachedTheSandbox(response.status, body) &&
        this.#clock.now() < retryUntil
      ) {
        await this.#clock.sleep(NOT_STARTED_RETRY_EVERY_MS);
        continue;
      }
      throw toError(method, path, response, body);
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

/**
 * The two refusals after which boat says a call is safe to send again: the sandbox was still
 * starting after boat's own 60 s hold, or its disk was still being mounted. Any other failure
 * of a command may have run it.
 */
function neverReachedTheSandbox(status: number, body: BoatErrorBody): boolean {
  if (status === 409 && body.code === "sandbox_starting") return true;
  return (
    status === 502 && body.code === "sandbox_direct_failed" && body.message === "sandbox_restoring"
  );
}

const NOT_RUNNING = new Set(["machine_not_running", "sandbox_not_ready", "sandbox_starting"]);
/** 429s that are about how many sandboxes run at once or what the plan allows, not about pace. */
const START_CAP = new Set(["limit_reached", "member_limit_reached", "trial_compute_limit_reached"]);

function toError(
  method: string,
  path: string,
  response: Response,
  body: BoatErrorBody,
): SandboxError {
  const { status } = response;
  const code = body.code ?? `http_${status}`;
  const message = `boat refused ${method} ${bare(path)}: ${status} ${code}${
    body.message && body.message !== code ? `: ${body.message}` : ""
  }`;
  const wait =
    Number(response.headers.get("retry-after")) || body.retryAfterSeconds || body.retryAfter;
  const retry = wait ? { retryAfterSeconds: wait } : {};

  if (status === 404) return new SandboxError("not_found", message);
  if (code === "snapshot_data_expired") return new SandboxError("snapshot_expired", message);
  if (NOT_RUNNING.has(code)) return new SandboxError("not_running", message);
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

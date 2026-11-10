import { describe, expect, test } from "bun:test";
import {
  alreadyStopped,
  asleepSandbox,
  boatSandbox,
  coldResume,
  commandFinished,
  created,
  deleting,
  ID,
  info,
  json,
  machineNotRunning,
  notFound,
  ORIGIN,
  processStatus,
  rateLimited,
  refusal,
  STREAM_LINES,
  sandboxNotReady,
  sandboxStopping,
  savedSnapshot,
  snapshotDataExpired,
  stopping,
  stream,
  TOKEN,
  warmResume,
} from "./boat.fixtures.ts";
import { BoatProvider } from "./boat.ts";
import { SandboxError, type SandboxErrorCode } from "./errors.ts";
import { FakeClock } from "./fake.ts";
import type { ExecEvent } from "./provider.ts";

const KEY = "boat_test_key";

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * boat, scripted. `on("GET /sandboxes/bx_1", a, b)` answers the first such call with `a` and
 * every later one with `b`, which is what polling needs. A call nobody scripted fails the test.
 */
function boat() {
  const sent: Sent[] = [];
  const script = new Map<string, Array<() => Response>>();
  const clock = new FakeClock();
  const provider = new BoatProvider({
    apiKey: KEY,
    clock,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      const path = pathname.replace("/api/v1", "") + search;
      const call = {
        method: init.method!,
        path,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      sent.push(call);
      const answers = script.get(`${call.method} ${path}`);
      if (!answers) throw new Error(`boat was not expecting ${call.method} ${path}`);
      return (answers.length > 1 ? answers.shift()! : answers[0]!)();
    },
  });
  return {
    provider,
    clock,
    sent,
    on(call: string, ...answers: Array<() => Response>) {
      script.set(call, answers);
    },
    count: (call: string) => sent.filter((s) => `${s.method} ${s.path}` === call).length,
  };
}

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SandboxError) return error;
    throw error;
  }
  throw new Error("expected a SandboxError");
}

async function collect(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const all: ExecEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("create", () => {
  test("sends what boat needs and returns the sandbox with its port address", async () => {
    const b = boat();
    b.on("POST /sandboxes", created);
    const result = await b.provider.create({
      idempotencyKey: "design-d1",
      from: "ponzu-base-v1",
      size: "medium",
      name: "design-d1",
      labels: { design: "d1" },
      env: { ANTHROPIC_API_KEY: "sk-secret" },
      ports: [4500],
      autoStopSeconds: 900,
    });

    expect(b.sent[0]!.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      "Idempotency-Key": "design-d1",
      "Content-Type": "application/json",
    });
    expect(b.sent[0]!.body).toEqual({
      from: "ponzu-base-v1",
      type: "default",
      noEnv: true,
      ttlSeconds: 900,
      name: "design-d1",
      labels: { design: "d1" },
      env: { ANTHROPIC_API_KEY: "sk-secret" },
      hostedPorts: [{ port: 4500 }],
    });
    expect(result.sandbox).toEqual({
      id: ID,
      state: "starting",
      labels: { design: "d1" },
      autoStopAt: Date.parse("2026-11-10T16:33:29.412Z"),
      reason: null,
    });
    // The token is split off the URL: the origin can be logged, the secret travels as a cookie.
    expect(result.addresses).toEqual([
      {
        port: 4500,
        url: ORIGIN,
        token: TOKEN,
        headers: { Cookie: `_port_auth=${TOKEN}` },
        query: { _token: TOKEN },
      },
    ]);
  });

  test("defaults to the stock image at the small size", async () => {
    const b = boat();
    b.on("POST /sandboxes", created);
    await b.provider.create({ idempotencyKey: "k", autoStopSeconds: 600 });
    expect(b.sent[0]!.body).toEqual({ type: "small", noEnv: true, ttlSeconds: 600 });
  });

  test("leaves out a port boat could not host", async () => {
    const b = boat();
    b.on("POST /sandboxes", () =>
      json(202, {
        sandbox: boatSandbox({ state: "provisioned" }),
        hostedPorts: [{ port: 4500, error: "host_failed", message: "no machine yet" }],
      }),
    );
    const result = await b.provider.create({
      idempotencyKey: "k",
      ports: [4500],
      autoStopSeconds: 600,
    });
    expect(result.addresses).toEqual([]);
  });

  const refusals: Array<[string, () => Response, SandboxErrorCode, number | undefined]> = [
    [
      "a base snapshot that does not exist",
      () => refusal(404, "snapshot_not_found", 'No saved snapshot "nope".'),
      "not_found",
      undefined,
    ],
    [
      "an idempotency key reused with other options",
      () => refusal(409, "idempotency_key_reused", "This Idempotency-Key was already used."),
      "conflict",
      undefined,
    ],
    ["a full start limit", rateLimited, "rate_limited", 37],
    [
      "too many sandboxes awake at once",
      () =>
        refusal(429, "limit_reached", "100 sandboxes run.", { headers: { "retry-after": "30" } }),
      "start_cap_reached",
      30,
    ],
    [
      "no machines left",
      () =>
        refusal(503, "out_of_capacity", "Out of machines.", { body: { retryAfterSeconds: 120 } }),
      "unavailable",
      120,
    ],
    ["a key that is not accepted", () => refusal(401, "unauthorized"), "rejected", undefined],
  ];
  for (const [what, answer, code, retryAfterSeconds] of refusals) {
    test(`reports ${what} as ${code}`, async () => {
      const b = boat();
      b.on("POST /sandboxes", answer);
      const error = await failure(b.provider.create({ idempotencyKey: "k", autoStopSeconds: 600 }));
      expect(error.code).toBe(code);
      expect(error.retryAfterSeconds).toBe(retryAfterSeconds);
    });
  }

  test("a 429 without Retry-After still says when to retry", async () => {
    const b = boat();
    b.on("POST /sandboxes", () => refusal(429, "rate_limited"));
    const error = await failure(b.provider.create({ idempotencyKey: "k", autoStopSeconds: 600 }));
    expect(error.retryAfterSeconds).toBe(60);
  });
});

describe("get and list", () => {
  const states: Array<[string, string]> = [
    ["init", "starting"],
    ["provisioning", "starting"],
    ["provisioned", "starting"],
    ["cloning", "starting"],
    ["ready", "awake"],
    ["idle", "awake"],
    ["running", "awake"],
    ["archiving", "stopping"],
    ["archived", "asleep"],
    ["error", "asleep"],
    ["a-state-boat-adds-later", "starting"],
  ];
  for (const [theirs, ours] of states) {
    test(`boat's ${theirs} is ${ours}`, async () => {
      const b = boat();
      b.on(`GET /sandboxes/${ID}`, () => info(boatSandbox({ state: theirs })));
      expect((await b.provider.get(ID)).state).toBe(ours as any);
    });
  }

  test("a sandbox boat does not know is gone, not an error", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}`, notFound);
    expect(await b.provider.get(ID)).toEqual({
      id: ID,
      state: "gone",
      labels: {},
      autoStopAt: null,
      reason: null,
    });
  });

  test("a create boat cancelled is gone, with the reason", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}`, () =>
      json(200, { sandbox: { id: ID, state: "cancelled", error: "no machine" } }),
    );
    expect(await b.provider.get(ID)).toMatchObject({ state: "gone", reason: "no machine" });
  });

  test("a sleeping sandbox has no auto-stop, whatever deadline boat still holds", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}`, () =>
      info(asleepSandbox({ archiveAfter: "2026-11-10T16:28:56.261Z", error: "machine lost" })),
    );
    expect(await b.provider.get(ID)).toMatchObject({
      state: "asleep",
      autoStopAt: null,
      reason: "machine lost",
    });
  });

  test("list filters by label and follows every page", async () => {
    const b = boat();
    b.on("GET /sandboxes?limit=200&label=design%3Dd1&label=env%3Ddev", () =>
      json(200, {
        sandboxes: [boatSandbox()],
        pageInfo: { nextCursor: "c2", hasMore: true, limit: 200 },
      }),
    );
    b.on("GET /sandboxes?limit=200&label=design%3Dd1&label=env%3Ddev&cursor=c2", () =>
      json(200, {
        sandboxes: [asleepSandbox({ id: "bx_22222222" })],
        pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
      }),
    );
    const found = await b.provider.list({ labels: { design: "d1", env: "dev" } });
    expect(found.map((s) => [s.id, s.state])).toEqual([
      [ID, "awake"],
      ["bx_22222222", "asleep"],
    ]);
  });
});

describe("resume, stop, extend", () => {
  test("a resume that boots a machine is a cold start and carries the new environment", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/resume`, coldResume);
    const result = await b.provider.resume(ID, { env: { TOKEN: "t2" }, autoStopSeconds: 900 });
    expect(b.sent[0]!.body).toEqual({ env: { TOKEN: "t2" }, ttlSeconds: 900 });
    expect(result.coldStart).toBe(true);
    expect(result.sandbox.state).toBe("starting");
  });

  test("a resume inside the warm window is not a cold start", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/resume`, warmResume);
    const result = await b.provider.resume(ID);
    expect(b.sent[0]!.body).toEqual({});
    expect(result).toMatchObject({ coldStart: false, sandbox: { state: "awake" } });
  });

  test("a new environment for a sandbox that is awake is a conflict, not a silent no-op", async () => {
    const b = boat();
    // boat answers 200 and keeps the old values.
    b.on(`POST /sandboxes/${ID}/resume`, warmResume);
    const error = await failure(b.provider.resume(ID, { env: { TOKEN: "t2" } }));
    expect(error.code).toBe("conflict");
  });

  test("a disk boat deleted is snapshot_expired", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/resume`, snapshotDataExpired);
    expect((await failure(b.provider.resume(ID))).code).toBe("snapshot_expired");
  });

  test("a resume while the stop still holds the machine is a conflict to retry", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/resume`, sandboxStopping);
    const error = await failure(b.provider.resume(ID));
    expect(error).toMatchObject({ code: "conflict", retryAfterSeconds: 5 });
  });

  test("a resume past the start limit is rate_limited with the wait", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/resume`, rateLimited);
    const error = await failure(b.provider.resume(ID));
    expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 37 });
  });

  test("stop returns while the sandbox is still stopping", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/stop`, stopping);
    expect(await b.provider.stop(ID)).toMatchObject({ state: "stopping", autoStopAt: null });
    expect(b.sent[0]!.body).toEqual({});
  });

  test("stopping a sandbox that sleeps is fine", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/stop`, alreadyStopped);
    expect((await b.provider.stop(ID)).state).toBe("asleep");
  });

  test("extend sets a new deadline", async () => {
    const b = boat();
    b.on(`PATCH /sandboxes/${ID}`, () =>
      json(200, {
        ok: true,
        type: "sandbox.updated",
        sandbox: boatSandbox({ archiveAfter: "2026-11-10T16:38:39.830Z", ttlSeconds: 1200 }),
      }),
    );
    const sandbox = await b.provider.extend(ID, 1200);
    expect(b.sent[0]!.body).toEqual({ ttlSeconds: 1200 });
    expect(sandbox.autoStopAt).toBe(Date.parse("2026-11-10T16:38:39.830Z"));
  });
});

describe("destroy", () => {
  test("confirms with the id header and waits for the 404", async () => {
    const b = boat();
    b.on(`DELETE /sandboxes/${ID}`, deleting);
    b.on(`GET /sandboxes/${ID}`, () => info(asleepSandbox()), notFound);
    await b.provider.destroy(ID);
    expect(b.sent[0]!.headers["X-Ascii-Confirm-Delete"]).toBe(ID);
    expect(b.count(`GET /sandboxes/${ID}`)).toBe(2);
  });

  test("a sandbox that is already gone needs no deleting", async () => {
    const b = boat();
    b.on(`DELETE /sandboxes/${ID}`, notFound);
    await b.provider.destroy(ID);
    expect(b.sent).toHaveLength(1);
  });

  test("gives up when boat never lets go of it", async () => {
    const b = boat();
    b.on(`DELETE /sandboxes/${ID}`, deleting);
    b.on(`GET /sandboxes/${ID}`, () => info(asleepSandbox()));
    const before = b.clock.now();
    const error = await failure(b.provider.destroy(ID));
    expect(error.code).toBe("unavailable");
    expect(b.clock.now() - before).toBe(60_000);
  });
});

describe("exec", () => {
  test("returns the command's result, failed or not", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      commandFinished({ success: false, exitCode: 3, stdout: "v=one\n", stderr: "err\n" }),
    );
    const result = await b.provider.exec(ID, "run-it", { cwd: "work", timeoutSeconds: 120 });
    expect(b.sent[0]!.body).toEqual({ command: "run-it", timeoutSeconds: 120, cwd: "work" });
    expect(result).toEqual({
      exitCode: 3,
      stdout: "v=one\n",
      stderr: "err\n",
      timedOut: false,
      truncated: false,
    });
  });

  test("reports a timeout and cut output", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      commandFinished({
        success: false,
        exitCode: 143,
        signal: "SIGTERM",
        stdout: "before\n",
        timedOut: true,
        stdoutTruncated: true,
      }),
    );
    const result = await b.provider.exec(ID, "sleep 5");
    expect(b.sent[0]!.body.timeoutSeconds).toBe(30);
    expect(result).toMatchObject({ exitCode: 143, timedOut: true, truncated: true });
  });

  test("a sandbox that sleeps or is going to sleep is not_running", async () => {
    for (const answer of [machineNotRunning, sandboxNotReady]) {
      const b = boat();
      b.on(`POST /sandboxes/${ID}/commands`, answer);
      expect((await failure(b.provider.exec(ID, "true"))).code).toBe("not_running");
      expect(b.sent).toHaveLength(1);
    }
  });

  test("waits out a start boat was still finishing, then runs the command once", async () => {
    const b = boat();
    b.on(
      `POST /sandboxes/${ID}/commands`,
      () =>
        refusal(409, "sandbox_starting", "Sandbox is starting.", { details: { retryable: true } }),
      () =>
        refusal(502, "sandbox_direct_failed", "sandbox_restoring", {
          details: { retryable: true },
        }),
      () => commandFinished({ stdout: "ok\n" }),
    );
    const before = b.clock.now();
    expect((await b.provider.exec(ID, "echo ok")).stdout).toBe("ok\n");
    expect(b.sent).toHaveLength(3);
    expect(b.clock.now() - before).toBe(2_000);
  });

  test("never re-sends a command that may have run", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      refusal(502, "sandbox_direct_failed", "socket hang up", { details: { retryable: false } }),
    );
    expect((await failure(b.provider.exec(ID, "git push"))).code).toBe("unavailable");
    expect(b.sent).toHaveLength(1);
  });

  test("stops waiting for a start after 30 seconds", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () => refusal(409, "sandbox_starting"));
    const before = b.clock.now();
    expect((await failure(b.provider.exec(ID, "true"))).code).toBe("not_running");
    expect(b.clock.now() - before).toBe(30_000);
  });
});

describe("execStream", () => {
  const whole = bytes(`${STREAM_LINES.join("\n")}\n`);
  const recorded: ExecEvent[] = [
    { type: "stdout", data: "out-1\n" },
    { type: "stderr", data: "err-1\n" },
    { type: "stdout", data: "no newline" },
    { type: "exit", exitCode: 4, timedOut: false },
  ];

  test("yields output as it arrives and ends with the exit", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () => stream([whole]));
    expect(await collect(b.provider.execStream(ID, "run-it", { cwd: "work" }))).toEqual(recorded);
    expect(b.sent[0]!.body).toEqual({
      command: "run-it",
      timeoutSeconds: 30,
      cwd: "work",
      stream: true,
    });
  });

  test("reads the same events however the bytes are split", async () => {
    for (const size of [1, 7, 64]) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < whole.length; at += size) chunks.push(whole.slice(at, at + size));
      const b = boat();
      b.on(`POST /sandboxes/${ID}/commands`, () => stream(chunks));
      expect(await collect(b.provider.execStream(ID, "run-it"))).toEqual(recorded);
    }
  });

  test("keeps a character whole when a chunk ends inside it", async () => {
    const line = bytes(
      '{"type":"stdout","data":"café ✓"}\n{"type":"exit","exitCode":0,"timedOut":false}',
    );
    const cut = line.indexOf(0xc3) + 1;
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () => stream([line.slice(0, cut), line.slice(cut)]));
    expect(await collect(b.provider.execStream(ID, "echo"))).toEqual([
      { type: "stdout", data: "café ✓" },
      { type: "exit", exitCode: 0, timedOut: false },
    ]);
  });

  test("a stream that ends without an exit is an error, not a silent success", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      stream([bytes(`${STREAM_LINES.slice(0, 2).join("\n")}\n`)]),
    );
    const seen: ExecEvent[] = [];
    const error = await failure(
      (async () => {
        for await (const event of b.provider.execStream(ID, "run-it")) seen.push(event);
      })(),
    );
    expect(seen).toEqual([{ type: "stdout", data: "out-1\n" }]);
    expect(error.code).toBe("unavailable");
  });

  test("an error frame from boat is unavailable", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      stream([
        bytes('{"type":"error","error":"sandbox_direct_failed","message":"agent went away"}\n'),
      ]),
    );
    const error = await failure(collect(b.provider.execStream(ID, "run-it")));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("agent went away");
  });

  test("a sandbox that sleeps fails before any output", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, machineNotRunning);
    expect((await failure(collect(b.provider.execStream(ID, "true")))).code).toBe("not_running");
  });
});

describe("processes", () => {
  test("spawn starts a detached command and returns its pid", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/commands`, () =>
      json(200, {
        ok: true,
        type: "command.started",
        success: true,
        processId: 6169,
        pid: 6169,
        command: "python3 -m http.server 4500",
        cwd: "work",
        startedAt: "2026-11-10T16:18:36.469Z",
        logPath: "/home/user/.ascii/processes/6169.log",
        errLogPath: "/home/user/.ascii/processes/6169.err.log",
        commandId: "cmd_y99ssb0dlgu9",
      }),
    );
    expect(await b.provider.spawn(ID, "python3 -m http.server 4500", { cwd: "work" })).toEqual({
      pid: 6169,
    });
    expect(b.sent[0]!.body).toEqual({
      command: "python3 -m http.server 4500",
      detached: true,
      cwd: "work",
    });
  });

  test("process reports a running one, a finished one, and one the sandbox forgot", async () => {
    const b = boat();
    const path = `GET /sandboxes/${ID}/commands/6169?tailBytes=65536`;
    b.on(
      path,
      () => processStatus(),
      () =>
        processStatus({
          status: "exited",
          running: false,
          exitCode: 1,
          stderr: "address in use\n",
        }),
      () => processStatus({ status: "lost", known: false, running: false, command: null }),
    );
    expect(await b.provider.process(ID, 6169)).toEqual({
      state: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
    });
    expect(await b.provider.process(ID, 6169)).toMatchObject({
      state: "exited",
      exitCode: 1,
      stderr: "address in use\n",
    });
    expect((await b.provider.process(ID, 6169)).state).toBe("lost");
  });

  test("kill is fine to repeat", async () => {
    const b = boat();
    b.on(`DELETE /sandboxes/${ID}/commands/6169`, () =>
      json(200, {
        ok: true,
        type: "command.stopped",
        processId: 6169,
        running: false,
        signaled: false,
        command: null,
      }),
    );
    await b.provider.kill(ID, 6169);
  });
});

describe("files", () => {
  test("reads bytes exactly", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}/files?path=work%2Fhello.txt&encoding=base64`, () =>
      json(200, {
        ok: true,
        type: "file.read",
        success: true,
        path: "work/hello.txt",
        encoding: "base64",
        size: 6,
        content: "aGVsbG8K",
      }),
    );
    expect(await b.provider.readFile(ID, "work/hello.txt")).toEqual(bytes("hello\n"));
  });

  test("a missing file is not_found", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}/files?path=work%2Fnone.txt&encoding=base64`, () =>
      refusal(
        400,
        "sandbox_direct_failed",
        "ENOENT: no such file or directory, stat '/home/user/work/none.txt'",
      ),
    );
    expect((await failure(b.provider.readFile(ID, "work/none.txt"))).code).toBe("not_found");
  });

  test("writes text and bytes as base64, in the body", async () => {
    const b = boat();
    b.on(`PUT /sandboxes/${ID}/files`, () =>
      json(200, {
        ok: true,
        type: "file.written",
        success: true,
        path: "work/hello.txt",
        encoding: "base64",
        size: 6,
      }),
    );
    await b.provider.writeFile(ID, "work/hello.txt", "hello\n");
    await b.provider.writeFile(ID, "work/raw.bin", new Uint8Array([0, 255, 128]));
    expect(b.sent.map((s) => s.body)).toEqual([
      { path: "work/hello.txt", content: "aGVsbG8K", encoding: "base64" },
      { path: "work/raw.bin", content: "AP+A", encoding: "base64" },
    ]);
  });

  test("a path outside what boat allows is rejected", async () => {
    const b = boat();
    b.on(`PUT /sandboxes/${ID}/files`, () =>
      refusal(400, "invalid_path", "Path must resolve under /home/user or /tmp."),
    );
    expect((await failure(b.provider.writeFile(ID, "/etc/x", "x"))).code).toBe("rejected");
  });

  test("a sandbox that sleeps is not_running", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}/files?path=a&encoding=base64`, machineNotRunning);
    expect((await failure(b.provider.readFile(ID, "a"))).code).toBe("not_running");
  });
});

describe("address", () => {
  const hosted = (url: string) => () =>
    json(200, {
      ok: true,
      type: "port.hosted",
      success: true,
      port: 4500,
      url,
      isProtected: true,
      access: "private",
      localhost: false,
    });

  test("returns the origin and the token apart", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/host`, hosted(`${ORIGIN}?_token=${TOKEN}`));
    const address = await b.provider.address(ID, 4500);
    expect(b.sent[0]!.body).toEqual({ port: 4500 });
    expect(address.url).toBe(ORIGIN);
    expect(address.url).not.toContain(TOKEN);
    expect(address.token).toBe(TOKEN);
    // boat takes the token as this cookie or as ?_token=; it ignores an Authorization header.
    expect(address.headers).toEqual({ Cookie: `_port_auth=${TOKEN}` });
    expect(address.query).toEqual({ _token: TOKEN });
  });

  test("a port someone made public has no token", async () => {
    const b = boat();
    b.on(`POST /sandboxes/${ID}/host`, hosted(ORIGIN));
    expect(await b.provider.address(ID, 4500)).toEqual({
      port: 4500,
      url: ORIGIN,
      token: null,
      headers: {},
      query: {},
    });
  });

  test("cannot be asked of a sandbox that sleeps", async () => {
    const b = boat();
    // For this one call boat sends machine_not_running as a 400, not a 409.
    b.on(`POST /sandboxes/${ID}/host`, () => machineNotRunning(400));
    expect((await failure(b.provider.address(ID, 4500))).code).toBe("not_running");
  });
});

describe("snapshots", () => {
  test("save returns while it is saving", async () => {
    const b = boat();
    b.on("POST /saved-snapshots", () =>
      json(202, {
        ok: true,
        type: "snapshot.saved.saving",
        status: "saving",
        snapshot: {
          name: "ponzu-base-v1",
          status: "saving",
          sourceSandboxId: ID,
          createdAt: "2026-11-10T16:18:41.729Z",
        },
      }),
    );
    expect(await b.provider.saveSnapshot(ID, "ponzu-base-v1")).toEqual({
      name: "ponzu-base-v1",
      state: "saving",
      sandboxId: ID,
      sizeBytes: null,
      createdAt: Date.parse("2026-11-10T16:18:41.729Z"),
      error: null,
    });
    expect(b.sent[0]!.body).toEqual({ sandboxId: ID, name: "ponzu-base-v1" });
  });

  test("saving a name that is mid-save is a conflict", async () => {
    const b = boat();
    b.on("POST /saved-snapshots", () =>
      refusal(409, "save_in_progress", '"ponzu-base-v1" is already being saved.'),
    );
    expect((await failure(b.provider.saveSnapshot(ID, "ponzu-base-v1"))).code).toBe("conflict");
  });

  test("get returns a ready or failed snapshot, and null for none", async () => {
    const b = boat();
    b.on(
      "GET /saved-snapshots/ponzu-base-v1",
      () => json(200, { ok: true, type: "snapshot.saved.info", snapshot: savedSnapshot() }),
      () =>
        json(200, { snapshot: savedSnapshot({ status: "failed", error: "capture timed out" }) }),
      notFound,
    );
    expect(await b.provider.getSnapshot("ponzu-base-v1")).toMatchObject({
      state: "ready",
      sizeBytes: 6418432,
    });
    expect(await b.provider.getSnapshot("ponzu-base-v1")).toMatchObject({
      state: "failed",
      error: "capture timed out",
    });
    expect(await b.provider.getSnapshot("ponzu-base-v1")).toBeNull();
  });

  test("list returns them all", async () => {
    const b = boat();
    b.on("GET /saved-snapshots", () =>
      json(200, {
        ok: true,
        type: "snapshot.saved.list",
        snapshots: [savedSnapshot(), savedSnapshot({ name: "repo-42" })],
        allowance: { included: 10, used: 2 },
      }),
    );
    expect((await b.provider.listSnapshots()).map((s) => s.name)).toEqual([
      "ponzu-base-v1",
      "repo-42",
    ]);
  });

  test("delete is fine to repeat", async () => {
    const b = boat();
    b.on(
      "DELETE /saved-snapshots/ponzu-base-v1",
      () =>
        json(200, {
          ok: true,
          type: "snapshot.saved.deleted",
          name: "ponzu-base-v1",
          status: "deleted",
        }),
      notFound,
    );
    await b.provider.deleteSnapshot("ponzu-base-v1");
    await b.provider.deleteSnapshot("ponzu-base-v1");
  });
});

test("usage turns boat's billed seconds back into awake seconds", async () => {
  const b = boat();
  b.on(`GET /sandboxes/${ID}/usage`, () =>
    json(200, {
      ok: true,
      type: "sandbox.usage",
      sandboxId: ID,
      sandboxType: "small",
      billingMultiplier: 0.5,
      since: "2026-11-10T16:18:29.347Z",
      until: "2026-11-10T16:18:40.085Z",
      seconds: 5,
      dollars: 0.00005,
      secondsPerDollar: 100000,
      running: true,
    }),
  );
  expect(await b.provider.usage(ID)).toEqual({ awakeSeconds: 10, costUsd: 0.00005, awake: true });
});

describe("ensureAwake", () => {
  const get = `GET /sandboxes/${ID}`;
  const resume = `POST /sandboxes/${ID}/resume`;
  const commands = `POST /sandboxes/${ID}/commands`;

  test("leaves an awake sandbox alone", async () => {
    const b = boat();
    b.on(get, () => info(boatSandbox({ state: "idle" })));
    const wake = await b.provider.ensureAwake(ID);
    expect(wake).toMatchObject({ start: "none", ms: 0, sandbox: { state: "awake" } });
    expect(b.sent).toHaveLength(1);
  });

  test("thaws a sandbox inside the warm window and checks it takes a command", async () => {
    const b = boat();
    b.on(get, () => info(asleepSandbox()));
    b.on(resume, warmResume);
    b.on(commands, () => commandFinished());
    const wake = await b.provider.ensureAwake(ID, { autoStopSeconds: 900 });
    expect(wake.start).toBe("warm");
    expect(b.sent.map((s) => `${s.method} ${s.path}`)).toEqual([get, resume, commands]);
    expect(b.sent[1]!.body).toEqual({ ttlSeconds: 900 });
    expect(b.sent[2]!.body.command).toBe("true");
  });

  test("boots a sandbox past it, polling until boat says ready", async () => {
    const b = boat();
    b.on(
      get,
      () => info(asleepSandbox()),
      () => info(boatSandbox({ state: "provisioned", hydrated: false })),
      () => info(boatSandbox({ state: "cloning", hydrated: false })),
      () => info(boatSandbox({ state: "ready", hydrated: false })),
    );
    b.on(resume, coldResume);
    b.on(commands, () => commandFinished());
    const wake = await b.provider.ensureAwake(ID, { env: { TOKEN: "t2" } });
    expect(wake).toMatchObject({ start: "cold", ms: 750, sandbox: { state: "awake" } });
    expect(b.count(resume)).toBe(1);
    expect(b.sent[1]!.body).toEqual({ env: { TOKEN: "t2" } });
  });

  test("waits for a stop to finish before resuming", async () => {
    const b = boat();
    b.on(
      get,
      () => info(boatSandbox({ state: "archiving" })),
      () => info(boatSandbox({ state: "archiving" })),
      () => info(asleepSandbox()),
    );
    // The sandbox reads as asleep a moment before boat lets it be resumed.
    b.on(resume, sandboxStopping, warmResume);
    b.on(commands, () => commandFinished());
    const wake = await b.provider.ensureAwake(ID);
    expect(wake).toMatchObject({ start: "warm", ms: 750 });
    expect(b.count(get)).toBe(4);
    expect(b.count(resume)).toBe(2);
  });

  test("a start someone else began counts as cold", async () => {
    const b = boat();
    b.on(
      get,
      () => info(boatSandbox({ state: "provisioned" })),
      () => info(boatSandbox()),
    );
    b.on(commands, () => commandFinished());
    const wake = await b.provider.ensureAwake(ID);
    expect(wake.start).toBe("cold");
    expect(b.count(resume)).toBe(0);
  });

  test("a sandbox that is gone is not_found", async () => {
    const b = boat();
    b.on(get, notFound);
    expect((await failure(b.provider.ensureAwake(ID))).code).toBe("not_found");
  });

  test("passes on a full start limit with its wait", async () => {
    const b = boat();
    b.on(get, () => info(asleepSandbox()));
    b.on(resume, rateLimited);
    const error = await failure(b.provider.ensureAwake(ID));
    expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 37 });
  });

  test("gives up on a start that hangs, without spending a second start", async () => {
    const b = boat();
    b.on(
      get,
      () => info(asleepSandbox()),
      () => info(boatSandbox({ state: "provisioned" })),
      // A start that fell back to sleep must not be resumed again by the same call.
      () => info(asleepSandbox()),
    );
    b.on(resume, coldResume);
    const error = await failure(b.provider.ensureAwake(ID, { timeoutMs: 20_000 }));
    expect(error.code).toBe("unavailable");
    expect(b.count(resume)).toBe(1);
    // Every 250 ms for the 5 s a start should take, then once a second.
    expect(b.count(get)).toBe(1 + 20 + 15);
  });
});

describe("when boat misbehaves", () => {
  test("a request that never lands is unavailable, and the key stays out of the message", async () => {
    const provider = new BoatProvider({
      apiKey: KEY,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await failure(provider.get(ID));
    expect(error.code).toBe("unavailable");
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain(KEY);
  });

  test("an error page instead of JSON is unavailable", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}`, () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const error = await failure(b.provider.get(ID));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("502");
  });

  test("a 200 that is not JSON is unavailable", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}/usage`, () => new Response("<html>ok</html>", { status: 200 }));
    expect((await failure(b.provider.usage(ID))).code).toBe("unavailable");
  });

  test("errors name the call but never its query or body", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}/files?path=secrets%2Ftoken.txt&encoding=base64`, () =>
      refusal(500, "http_500", "Internal error"),
    );
    b.on("POST /sandboxes", () => refusal(400, "invalid_env", "env is invalid"));
    const read = await failure(b.provider.readFile(ID, "secrets/token.txt"));
    expect(read.message).toBe(
      `boat refused GET /sandboxes/${ID}/files: 500 http_500: Internal error`,
    );
    const create = await failure(
      b.provider.create({ idempotencyKey: "k", env: { TOKEN: "sk-secret" }, autoStopSeconds: 60 }),
    );
    expect(create.message).not.toContain("sk-secret");
  });

  test("the key is only ever a bearer header", async () => {
    const b = boat();
    b.on(`GET /sandboxes/${ID}`, () => info());
    await b.provider.get(ID);
    expect(b.sent[0]!.path).not.toContain(KEY);
    expect(b.sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(b.provider)).not.toContain(KEY);
  });
});

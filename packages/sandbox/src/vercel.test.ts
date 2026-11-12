/*
 * vercel.ts against @vercel/sandbox 3.9.1, through WithFetchOptions.fetch, which the SDK wraps in
 * its own withRetry. Every body here was recorded from real sandboxes by vercel.live.test.ts
 * (fixtures/vercel-live.json, 2026-11-11, team northbrook, project ponzu-api, region iad1), or is
 * a recorded body with one field changed, said where it is. Only the 429, 5xx, 422 and stream
 * error bodies are made up, in the recorded error shape, because a live run cannot provoke them.
 *
 * What the live run recorded (the spec's open questions):
 * - A create on a name in use: 400 {code:"bad_request", message:"A sandbox with the name '…'
 *   already exists for this project. Use GET /sandboxes/:name to resume it or delete it first."}.
 *   Not a 409, and no specific code: up() matches it by status, code and message, as busy.
 * - image_not_ready: never answered. An image (410.8 MB) pushed to a new VCR repository and
 *   created from within a second of the push was created at once; VCR listed it Ready. The code
 *   stays mapped to busy from up(), by code alone, as the images docs name it.
 * - An image tag or digest that does not exist: 404 {code:"not_found", message:"Image not found."}
 *   on create, which is rejected (and after an image-change delete the name is simply gone).
 * - SIGTERM grace of stop(): 19.99 s in the committed fixture (found.sigtermGraceMs), and 20.00 s
 *   in an earlier run that is not kept. stop() sends SIGTERM to running
 *   commands, waits about 20 s for them to exit, then kills them and snapshots: a stop with a
 *   process that ignores SIGTERM took 21.3 to 24.3 s, against 2 to 3 s when everything exits. A
 *   waited command cut off by the stop resolved with exit code 143, not a StreamError.
 * - A name is reusable right after delete: the next create, sent at once, succeeded (628 ms in
 *   the committed fixture, 778 ms in an earlier run that is not kept: the create's own time). So up()'s recreate does not wait.
 * - A 64 KB command env is accepted (65,536 bytes read back). 128 KB in one variable is refused,
 *   400 command_failed "fork/exec /usr/bin/sh: argument list too long": Linux's 128 KiB limit on
 *   one argv or env string, so 64 KB is our cap with room, not Vercel's.
 * - A pinned call on a stopped session: 410 {code:"sandbox_stopped"} (cmd and extend-timeout).
 * - stop() on a session that already stopped answers 200 with the old snapshot again, so stop()
 *   always looks first (one get) and answers {stopped:false} without calling it.
 * - Extending past the 24 h cap: 400 {code:"sandbox_timeout_invalid", "extension would exceed
 *   maximum execution timeout"}: rejected.
 * - update() on a stopped sandbox leaves it stopped (the PATCH answer reads "stopped"); the next
 *   session has the new timeout.
 * - A resumed session routes Vercel's interactive port too ("system": true, which the SDK's
 *   validator strips), so the port drift check ignores session.interactivePort.
 * - keepLastSnapshots reads back as {count:1, expiration:<snapshotExpiration>, deleteEvicted:true}.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClock, systemClock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import { FakeSandboxes } from "./fake.ts";
import type { At, Sandboxes, SandboxSpec } from "./sandboxes.ts";
import { vercelSandboxes } from "./vercel.ts";

interface Exchange {
  step: string;
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const recorded = (await Bun.file(join(import.meta.dir, "fixtures", "vercel-live.json")).json()) as {
  exchanges: Exchange[];
};

function exchange(
  step: string,
  method: string,
  path = "",
  query: Record<string, string> = {},
  nth = 0,
) {
  const found = recorded.exchanges.filter(
    (each) =>
      each.step === step &&
      each.method === method &&
      each.path.includes(path) &&
      Object.entries(query).every(([key, value]) => each.query[key] === value),
  )[nth];
  if (!found) throw new Error(`no recorded ${method} ${path} in ${step}`);
  return found;
}

function reply(ex: Exchange, edit?: (json: any) => void): Response {
  let body = ex.body;
  if (edit) {
    const json = JSON.parse(body);
    edit(json);
    body = JSON.stringify(json);
  }
  return new Response(body, { status: ex.status, headers: ex.headers });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

// The recorded bodies.
const MISSING = exchange("up_create", "GET");
const CREATED = exchange("up_create", "POST", "/v3/sandboxes");
const RUNNING = exchange("up_running", "GET");
const STOPPED = exchange("up_drift_resume", "GET", "", { resume: "false" });
const PATCHED = exchange("up_drift_resume", "PATCH");
const RESUMED = exchange("up_drift_resume", "GET", "", { resume: "true" });
const RESUMED_RUNNING = exchange("up_resumed_running", "GET");
const DETACHED = exchange("start_server", "POST", "/cmd");
const WAITED = exchange("exec", "POST", "/cmd");
const STOPPED_410 = exchange("pinned_after_stop_cached", "POST", "/cmd");
const EXTENDED = exchange("extend", "POST", "/extend-timeout");
const PAST_CAP = exchange("extend_past_cap", "POST", "/extend-timeout");
const STOP = exchange("stop", "POST", "/stop");
const DELETED = exchange("up_other_digest", "DELETE");
const NO_IMAGE = exchange("up_other_digest", "POST", "/v3/sandboxes");
const DUPLICATE = exchange("duplicate_create", "POST", "/v3/sandboxes");
const LISTED = exchange("list", "GET");
const WROTE = exchange("write_server", "POST", "/fs/write");
const READ = exchange("env_128k", "POST", "/fs/read", {}, 0);
const READ_MISSING = exchange("env_128k", "POST", "/fs/read", {}, 1);

const created = JSON.parse(CREATED.body);
const NAME: string = created.sandbox.name;
const FIRST: string = created.session.id;
const SECOND: string = JSON.parse(RESUMED.body).session.id;
const IMAGE = `ponzu-runner-spike@${(created.sandbox.image as string).split("@")[1]}`;
const SPEC: SandboxSpec = {
  image: IMAGE,
  persistent: true,
  timeoutMs: 5 * 60_000,
  ports: [4600],
  vcpus: 2,
  snapshotExpirationMs: 24 * 3600_000,
};

type Rule = [method: string, path: RegExp, ...replies: Array<Response | (() => Response)>];

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

/** A fetch that answers by rule, in order per rule (the last reply repeats), and records calls. */
function server(...rules: Rule[]) {
  const calls: Call[] = [];
  const used = new Map<Rule, number>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    let body: any;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const rule = rules.find(([m, path]) => m === method && path.test(url.pathname));
    if (!rule)
      return json(599, { error: { code: "unscripted", message: `${method} ${url.pathname}` } });
    const replies = rule.slice(2) as Array<Response | (() => Response)>;
    const index = Math.min(used.get(rule) ?? 0, replies.length - 1);
    used.set(rule, (used.get(rule) ?? 0) + 1);
    const next = replies[index]!;
    if (next instanceof Response) return next.clone();
    return next();
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    /** "GET /api/v2/sandboxes/x?resume=false" per call. */
    lines: () =>
      calls.map((call) => {
        const resume = call.query.get("resume");
        const orphans = call.query.get("deleteOrphanSnapshots");
        const suffix = resume
          ? `?resume=${resume}`
          : orphans
            ? `?deleteOrphanSnapshots=${orphans}`
            : "";
        return `${call.method} ${call.path.replace(/\/api/, "").replace(/sessions\/[^/]+/, (m) => m)}${suffix}`;
      }),
  };
}

const credentials = { token: "test-token", teamId: "team_test", projectId: "prj_test" };
const make = (fetch: typeof globalThis.fetch): Sandboxes =>
  vercelSandboxes({ clock: systemClock, credentials, fetch });

const SANDBOX = new RegExp(`^/api/v2/sandboxes/${NAME}$`);
const CREATE = /^\/api\/v3\/sandboxes$/;
const session = (id: string, rest: string) =>
  new RegExp(`^/api/v2/sandboxes/sessions/${id}/${rest}$`);

async function failure(work: Promise<unknown>): Promise<SandboxError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SandboxError);
  return error as SandboxError;
}

describe("up", () => {
  test("a missing name: get without resume, then one create with the spec's params and no env", async () => {
    const api = server(["GET", SANDBOX, reply(MISSING)], ["POST", CREATE, reply(CREATED)]);
    const up = await make(api.fetch).up(NAME, SPEC);
    expect(api.lines()).toEqual([`GET /v2/sandboxes/${NAME}?resume=false`, "POST /v3/sandboxes"]);
    const body = api.calls[1]!.body;
    expect(body).toMatchObject({
      name: NAME,
      image: IMAGE,
      persistent: true,
      ports: [4600],
      timeout: 300_000,
      resources: { vcpus: 2 },
      region: "iad1",
      snapshotExpiration: 86_400_000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      projectId: "prj_test",
    });
    expect(body.env).toBeUndefined();
    expect(up).toMatchObject({
      name: NAME,
      sessionId: FIRST,
      fresh: true,
      recreated: false,
      wasRunning: false,
      image: created.sandbox.image,
    });
    expect(up.startedAt).toBe(created.session.startedAt);
    expect(up.expiresAt).toBe(created.session.startedAt + created.session.timeout);
    expect(up.urls[4600]).toBe(created.routes.find((r: any) => r.port === 4600).url);
  });

  test("a running sandbox: one get, wasRunning, no update and no resume", async () => {
    const api = server(["GET", SANDBOX, reply(RUNNING)]);
    const up = await make(api.fetch).up(NAME, SPEC);
    expect(api.lines()).toEqual([`GET /v2/sandboxes/${NAME}?resume=false`]);
    expect(up).toMatchObject({ sessionId: FIRST, wasRunning: true, fresh: true });
  });

  test("a resumed running session routes Vercel's interactive port too: still no drift", async () => {
    const api = server(["GET", SANDBOX, reply(RESUMED_RUNNING)]);
    const up = await make(api.fetch).up(NAME, { ...SPEC, timeoutMs: 6 * 60_000 });
    expect(api.lines()).toEqual([`GET /v2/sandboxes/${NAME}?resume=false`]);
    expect(up).toMatchObject({ sessionId: SECOND, wasRunning: true, fresh: false });
    expect(Object.keys(up.urls)).toEqual(["4600"]);
  });

  test("a stopped sandbox with drift: update first (no resume), then the one resume", async () => {
    const api = server(["GET", SANDBOX, reply(STOPPED)], ["PATCH", SANDBOX, reply(PATCHED)]);
    // getOrCreate's resume is a GET on the same path; answer by query.
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get("resume") === "true") {
        api.calls.push({
          method: "GET",
          path: url.pathname,
          query: url.searchParams,
          body: undefined,
        });
        return reply(RESUMED);
      }
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
    const up = await make(fetch).up(NAME, { ...SPEC, timeoutMs: 6 * 60_000 });
    expect(api.lines()).toEqual([
      `GET /v2/sandboxes/${NAME}?resume=false`,
      `PATCH /v2/sandboxes/${NAME}`,
      `GET /v2/sandboxes/${NAME}?resume=true`,
    ]);
    expect(api.calls[1]!.body).toEqual({ timeout: 360_000 });
    expect(up).toMatchObject({
      sessionId: SECOND,
      fresh: false,
      wasRunning: false,
      recreated: false,
    });
    expect(up.expiresAt - up.startedAt).toBe(360_000);
  });

  test("a stopped sandbox without drift: no update, resume, and resumed:true means not wasRunning", async () => {
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.searchParams.get("resume")}`);
      return url.searchParams.get("resume") === "true"
        ? reply(RESUMED)
        : reply(STOPPED, (body) => {
            body.sandbox.timeout = 360_000;
          });
    }) as typeof globalThis.fetch;
    const up = await make(fetch).up(NAME, { ...SPEC, timeoutMs: 6 * 60_000 });
    expect(calls).toEqual(["GET false", "GET true"]);
    expect(up.wasRunning).toBe(false);
  });

  test("resumed:false from the resume means it was already running: wasRunning", async () => {
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("resume") === "true"
        ? reply(RESUMED, (body) => {
            body.resumed = false;
          })
        : reply(STOPPED, (body) => {
            body.sandbox.timeout = 360_000;
          });
    }) as typeof globalThis.fetch;
    expect((await make(fetch).up(NAME, { ...SPEC, timeoutMs: 6 * 60_000 })).wasRunning).toBe(true);
  });

  test("another image digest: delete with orphan snapshots, then create; nothing resumes first", async () => {
    const other = `ponzu-runner@sha256:${"0".repeat(64)}`;
    const api = server(
      ["GET", SANDBOX, reply(STOPPED)],
      ["DELETE", SANDBOX, reply(DELETED)],
      [
        "POST",
        CREATE,
        reply(CREATED, (body) => {
          body.sandbox.image = `northbrook/ponzu-api/ponzu-runner@sha256:${"0".repeat(64)}`;
        }),
      ],
    );
    const up = await make(api.fetch).up(NAME, { ...SPEC, image: other });
    expect(api.lines()).toEqual([
      `GET /v2/sandboxes/${NAME}?resume=false`,
      `DELETE /v2/sandboxes/${NAME}?deleteOrphanSnapshots=true`,
      "POST /v3/sandboxes",
    ]);
    expect(api.calls.some((call) => call.query.get("resume") === "true")).toBe(false);
    expect(up).toMatchObject({ recreated: true, fresh: true, wasRunning: false });
    expect(api.calls[2]!.body.image).toBe(other);
  });

  test("the same digest under the full repository path is not a change", async () => {
    const api = server(["GET", SANDBOX, reply(RUNNING)]);
    expect(created.sandbox.image).toStartWith("northbrook/ponzu-api/");
    await make(api.fetch).up(NAME, SPEC);
    expect(api.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("a name in use (recorded 400 bad_request 'already exists') is busy", async () => {
    const api = server(["GET", SANDBOX, reply(MISSING)], ["POST", CREATE, reply(DUPLICATE)]);
    const error = await failure(make(api.fetch).up(NAME, SPEC));
    expect(error.code).toBe("busy");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("image_not_ready (the docs' code; never recorded) is busy", async () => {
    const api = server(
      ["GET", SANDBOX, reply(MISSING)],
      [
        "POST",
        CREATE,
        json(400, { error: { code: "image_not_ready", message: "Image is not ready." } }),
      ],
    );
    expect((await failure(make(api.fetch).up(NAME, SPEC))).code).toBe("busy");
  });

  test("an image that does not exist (recorded 404 not_found) is rejected, not 'missing'", async () => {
    const api = server(["GET", SANDBOX, reply(MISSING)], ["POST", CREATE, reply(NO_IMAGE)]);
    expect((await failure(make(api.fetch).up(NAME, SPEC))).code).toBe("rejected");
  });

  test("another bad_request is rejected, not busy", async () => {
    const api = server(
      ["GET", SANDBOX, reply(MISSING)],
      ["POST", CREATE, json(400, { error: { code: "bad_request", message: "ports: too many" } })],
    );
    expect((await failure(make(api.fetch).up(NAME, SPEC))).code).toBe("rejected");
  });
});

describe("pinned calls", () => {
  async function upped() {
    const api = server(
      ["GET", SANDBOX, reply(MISSING)],
      ["POST", CREATE, reply(CREATED)],
      ["POST", session(FIRST, "cmd"), reply(WAITED)],
      ["POST", session(FIRST, "extend-timeout"), reply(EXTENDED)],
      ["POST", session(FIRST, "fs/write"), reply(WROTE)],
      ["POST", session(FIRST, "fs/read"), reply(READ), reply(READ_MISSING)],
    );
    const sandboxes = make(api.fetch);
    const up = await sandboxes.up(NAME, SPEC);
    api.calls.length = 0;
    return { api, sandboxes, at: { name: NAME, sessionId: up.sessionId } };
  }

  test("exec on the session up() returned goes straight to /sessions/{id}/cmd", async () => {
    const { api, sandboxes, at } = await upped();
    const result = await sandboxes.exec(at, {
      cmd: "sh",
      args: ["-c", "x"],
      env: { A: "1" },
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    expect(api.lines()).toEqual([`POST /v2/sandboxes/sessions/${FIRST}/cmd`]);
    expect(api.calls[0]!.body).toMatchObject({
      command: "sh",
      args: ["-c", "x"],
      env: { A: "1" },
      wait: true,
      timeout: 30_000,
    });
  });

  test("files go to the session too; a missing file is null", async () => {
    const { api, sandboxes, at } = await upped();
    await sandboxes.writeFile(at, "/vercel/a.txt", "hello");
    const back = await sandboxes.readFile(at, "/vercel/kept.txt");
    expect(new TextDecoder().decode(back!)).toBe("kept across a stop");
    expect(await sandboxes.readFile(at, "/vercel/missing.txt")).toBeNull();
    expect(api.lines()).toEqual([
      `POST /v2/sandboxes/sessions/${FIRST}/fs/write`,
      `POST /v2/sandboxes/sessions/${FIRST}/fs/read`,
      `POST /v2/sandboxes/sessions/${FIRST}/fs/read`,
    ]);
  });

  test("extend hits the session and reads the new deadline back from the answer", async () => {
    const { api, sandboxes, at } = await upped();
    const deadline = await sandboxes.extend(at, 60_000);
    const answered = JSON.parse(EXTENDED.body).session;
    expect(deadline).toBe(answered.startedAt + answered.timeout);
    expect(api.lines()).toEqual([`POST /v2/sandboxes/sessions/${FIRST}/extend-timeout`]);
    expect(api.calls[0]!.body).toEqual({ duration: 60_000 });
  });

  test("extend past the 24 h cap (recorded 400 sandbox_timeout_invalid) is rejected", async () => {
    const api = server(
      ["POST", session(FIRST, "extend-timeout"), reply(PAST_CAP)],
      ["GET", SANDBOX, reply(RUNNING)],
    );
    const error = await failure(
      make(api.fetch).extend({ name: NAME, sessionId: FIRST }, 25 * 3600_000),
    );
    expect(error.code).toBe("rejected");
  });

  test("start is a detached command in the session and answers its id", async () => {
    const api = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "cmd"), reply(DETACHED)],
    );
    const started = await make(api.fetch).start(
      { name: NAME, sessionId: FIRST },
      { cmd: "/opt/ponzu/bin/ponzu-start", env: { PONZU_PORT_TOKEN: "t" }, sudo: true },
    );
    expect(started.commandId).toBe(JSON.parse(DETACHED.body).command.id);
    const body = api.calls[1]!.body;
    expect(body).toMatchObject({
      command: "/opt/ponzu/bin/ponzu-start",
      sudo: true,
      env: { PONZU_PORT_TOKEN: "t" },
    });
    expect(body.wait).toBeUndefined();
  });

  test("without a held handle: one get without resume, then the session call", async () => {
    const api = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "cmd"), reply(WAITED)],
    );
    const sandboxes = make(api.fetch);
    await sandboxes.exec({ name: NAME, sessionId: FIRST }, { cmd: "sh", timeoutMs: 1_000 });
    await sandboxes.exec({ name: NAME, sessionId: FIRST }, { cmd: "sh", timeoutMs: 1_000 });
    expect(api.lines()).toEqual([
      `GET /v2/sandboxes/${NAME}?resume=false`,
      `POST /v2/sandboxes/sessions/${FIRST}/cmd`,
      `POST /v2/sandboxes/sessions/${FIRST}/cmd`,
    ]);
  });

  test("another session is not_running, and nothing is called on it", async () => {
    const api = server(["GET", SANDBOX, reply(RESUMED_RUNNING)]);
    const sandboxes = make(api.fetch);
    const at = { name: NAME, sessionId: FIRST };
    expect((await failure(sandboxes.exec(at, { cmd: "true", timeoutMs: 1 }))).code).toBe(
      "not_running",
    );
    expect((await failure(sandboxes.start(at, { cmd: "true" }))).code).toBe("not_running");
    expect((await failure(sandboxes.readFile(at, "/x"))).code).toBe("not_running");
    expect(await sandboxes.extend(at, 1_000)).toBeNull();
    expect(await sandboxes.stop(at)).toEqual({ stopped: false, snapshotBytes: null });
    expect(
      api.calls.every((call) => call.method === "GET" && call.query.get("resume") === "false"),
    ).toBe(true);
  });

  test("a stopped current session is not_running without a call; a missing sandbox too", async () => {
    const api = server(["GET", SANDBOX, reply(STOPPED)]);
    const at = { name: NAME, sessionId: FIRST };
    expect((await failure(make(api.fetch).exec(at, { cmd: "true", timeoutMs: 1 }))).code).toBe(
      "not_running",
    );
    expect(api.calls).toHaveLength(1);
    const gone = server(["GET", SANDBOX, reply(MISSING)]);
    expect((await failure(make(gone.fetch).exec(at, { cmd: "true", timeoutMs: 1 }))).code).toBe(
      "not_running",
    );
  });

  test("the held session stopped meanwhile: recorded 410 sandbox_stopped is not_running", async () => {
    const at = { name: NAME, sessionId: FIRST };
    const held = server(
      ["GET", SANDBOX, reply(MISSING)],
      ["POST", CREATE, reply(CREATED)],
      ["POST", session(FIRST, "cmd"), reply(STOPPED_410)],
      ["POST", session(FIRST, "extend-timeout"), reply(STOPPED_410)],
    );
    const fresh = make(held.fetch);
    await fresh.up(NAME, SPEC);
    expect((await failure(fresh.exec(at, { cmd: "true", timeoutMs: 1 }))).code).toBe("not_running");
    expect(await fresh.extend(at, 1_000)).toBeNull();
    expect(held.lines().slice(2)).toEqual([
      `POST /v2/sandboxes/sessions/${FIRST}/cmd`,
      `POST /v2/sandboxes/sessions/${FIRST}/extend-timeout`,
    ]);
  });

  test("422 sandbox_stopping or sandbox_snapshotting on a session call is not_running", async () => {
    for (const code of ["sandbox_stopping", "sandbox_snapshotting"]) {
      const api = server(
        ["GET", SANDBOX, reply(RUNNING)],
        ["POST", session(FIRST, "cmd"), json(422, { error: { code, message: code } })],
      );
      const error = await failure(
        make(api.fetch).exec({ name: NAME, sessionId: FIRST }, { cmd: "true", timeoutMs: 1 }),
      );
      expect(error.code).toBe("not_running");
    }
  });

  test("a stream error mid-command: not_running when the session ended, unavailable when it runs on", async () => {
    const broken = () =>
      new Response(
        `${WAITED.body.split("\n")[0]}\n${JSON.stringify({ stream: "error", data: { code: "sandbox_stopped", message: "stopped" } })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      );
    const ended = server(
      ["GET", SANDBOX, reply(RUNNING), reply(STOPPED)],
      ["POST", session(FIRST, "cmd"), broken],
    );
    const at = { name: NAME, sessionId: FIRST };
    expect(
      (await failure(make(ended.fetch).exec(at, { cmd: "sleep", timeoutMs: 1_000 }))).code,
    ).toBe("not_running");
    const runsOn = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "cmd"), broken],
    );
    expect(
      (await failure(make(runsOn.fetch).exec(at, { cmd: "sleep", timeoutMs: 1_000 }))).code,
    ).toBe("unavailable");
  });

  test("stop always looks first: running → /sessions/{id}/stop with the snapshot size", async () => {
    const at = { name: NAME, sessionId: FIRST };
    const swapped = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "stop"), reply(STOP)],
    );
    const result = await make(swapped.fetch).stop(at);
    expect(result).toEqual({
      stopped: true,
      snapshotBytes: JSON.parse(STOP.body).snapshot.sizeBytes,
    });
    expect(swapped.lines()).toEqual([
      `GET /v2/sandboxes/${NAME}?resume=false`,
      `POST /v2/sandboxes/sessions/${FIRST}/stop`,
    ]);
  });

  test("stop on a session that already stopped (Vercel would answer 200 again) does not call stop", async () => {
    const api = server(
      ["GET", SANDBOX, reply(STOPPED)],
      ["POST", session(FIRST, "stop"), reply(STOP)],
    );
    expect(await make(api.fetch).stop({ name: NAME, sessionId: FIRST })).toEqual({
      stopped: false,
      snapshotBytes: null,
    });
    expect(api.calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("status, list, remove", () => {
  test("status reads without resuming; a missing name is null", async () => {
    const api = server(["GET", SANDBOX, reply(STOPPED)]);
    expect(await make(api.fetch).status(NAME)).toEqual({
      name: NAME,
      status: "stopped",
      sessionId: FIRST,
      image: created.sandbox.image,
      createdAt: JSON.parse(STOPPED.body).sandbox.createdAt,
    });
    expect(api.calls[0]!.query.get("resume")).toBe("false");
    expect(await make(server(["GET", SANDBOX, reply(MISSING)]).fetch).status(NAME)).toBeNull();
  });

  test("list sends namePrefix with sortBy name and follows every page", async () => {
    const page = JSON.parse(LISTED.body);
    const api = server([
      "GET",
      /^\/api\/v2\/sandboxes$/,
      json(200, {
        ...page,
        sandboxes: page.sandboxes.slice(0, 1),
        pagination: { count: 1, next: "c2" },
      }),
      json(200, {
        ...page,
        sandboxes: page.sandboxes.slice(1),
        pagination: { count: page.sandboxes.length - 1, next: null },
      }),
    ]);
    const listed = await make(api.fetch).list("pz-test-live-");
    expect(listed.map((each) => each.name)).toEqual(page.sandboxes.map((each: any) => each.name));
    expect(listed[0]).toEqual({
      name: page.sandboxes[0].name,
      status: page.sandboxes[0].status,
      sessionId: page.sandboxes[0].currentSessionId,
      image: page.sandboxes[0].image,
      createdAt: page.sandboxes[0].createdAt,
    });
    expect(
      api.calls.map((call) => [
        call.query.get("namePrefix"),
        call.query.get("sortBy"),
        call.query.get("cursor"),
      ]),
    ).toEqual([
      ["pz-test-live-", "name", null],
      ["pz-test-live-", "name", "c2"],
    ]);
  });

  test("remove is get then delete with orphan snapshots; missing is success", async () => {
    const api = server(["GET", SANDBOX, reply(STOPPED)], ["DELETE", SANDBOX, reply(DELETED)]);
    await make(api.fetch).remove(NAME);
    expect(api.lines()).toEqual([
      `GET /v2/sandboxes/${NAME}?resume=false`,
      `DELETE /v2/sandboxes/${NAME}?deleteOrphanSnapshots=true`,
    ]);
    const gone = server(["GET", SANDBOX, reply(MISSING)]);
    await make(gone.fetch).remove(NAME);
    expect(gone.calls).toHaveLength(1);
    const raced = server(["GET", SANDBOX, reply(STOPPED)], ["DELETE", SANDBOX, reply(MISSING)]);
    await make(raced.fetch).remove(NAME);
  });
});

describe("errors, with the SDK's own retries", () => {
  test("429 with Retry-After over 20 s: the SDK gives up at once; rate_limited with the header", async () => {
    const api = server(["GET", SANDBOX, json(429, {}, { "retry-after": "30" })]);
    const error = await failure(make(api.fetch).status(NAME));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(30);
    expect(api.calls).toHaveLength(1);
  });

  test("429 with a short Retry-After: the SDK sleeps it out twice more, then rate_limited", async () => {
    const api = server(["GET", SANDBOX, json(429, {}, { "retry-after": "1" })]);
    const started = performance.now();
    const error = await failure(make(api.fetch).status(NAME));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(1);
    expect(api.calls).toHaveLength(3);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 30_000);

  test("a 429 the SDK retried past answers normally", async () => {
    const api = server(["GET", SANDBOX, json(429, {}, { "retry-after": "1" }), reply(RUNNING)]);
    expect((await make(api.fetch).status(NAME))?.status).toBe("running");
    expect(api.calls).toHaveLength(2);
  }, 30_000);

  test("5xx: the SDK retries twice (400/800 ms backoff), then unavailable", async () => {
    const api = server([
      "GET",
      SANDBOX,
      json(503, { error: { code: "internal", message: "down" } }),
    ]);
    const error = await failure(make(api.fetch).status(NAME));
    expect(error.code).toBe("unavailable");
    expect(api.calls).toHaveLength(3);
  }, 30_000);

  test("a waited command is never retried by the SDK: one 5xx is unavailable", async () => {
    const api = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "cmd"), json(502, { error: { code: "bad_gateway", message: "x" } })],
    );
    const error = await failure(
      make(api.fetch).exec({ name: NAME, sessionId: FIRST }, { cmd: "true", timeoutMs: 1 }),
    );
    expect(error.code).toBe("unavailable");
    expect(api.calls.filter((call) => call.path.endsWith("/cmd"))).toHaveLength(1);
  });

  test("a network failure is unavailable", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect((await failure(make(fetch).status(NAME))).code).toBe("unavailable");
  }, 30_000);

  test("the recorded 128 KB env refusal (400 command_failed) is rejected", async () => {
    const refused = exchange("env_128k", "POST", "/cmd");
    const api = server(
      ["GET", SANDBOX, reply(RUNNING)],
      ["POST", session(FIRST, "cmd"), reply(refused)],
    );
    const error = await failure(
      make(api.fetch).exec({ name: NAME, sessionId: FIRST }, { cmd: "sh", timeoutMs: 1 }),
    );
    expect(error.code).toBe("rejected");
  });
});

test("credentials are all three or none", () => {
  expect(() =>
    vercelSandboxes({
      clock: systemClock,
      credentials: { token: "t", teamId: "", projectId: "p" },
    }),
  ).toThrow();
  expect(() => vercelSandboxes({ clock: systemClock })).not.toThrow();
});

/*
 * One table of behaviours, run against both FakeSandboxes (on which every lifecycle test of the
 * API sits) and vercelSandboxes replaying the recorded bodies, so the fake cannot drift from what
 * Vercel was seen to do. Each case makes the same state both ways and answers a plain summary.
 */
describe("the fake agrees with the recording", () => {
  const BIG = "x".repeat(128 * 1024);
  const OTHER_IMAGE = `ponzu-runner@sha256:${"0".repeat(64)}`;
  const outcome = async (work: Promise<unknown>, summary: (value: any) => unknown) =>
    work.then(summary, (error: unknown) =>
      error instanceof SandboxError ? { error: error.code } : { thrown: String(error) },
    );
  const upSummary = (up: any) => ({
    fresh: up.fresh,
    recreated: up.recreated,
    wasRunning: up.wasRunning,
  });

  interface Case {
    name: string;
    /** The state, made on the fake; answers the session the check pins to. */
    fake: (fake: FakeSandboxes) => Promise<At>;
    /** The same state as Vercel answered it, pinned to the recording's first session. */
    replay: () => typeof globalThis.fetch;
    check: (sandboxes: Sandboxes, at: At) => Promise<unknown>;
    expected: unknown;
  }

  const runningFake = async (fake: FakeSandboxes): Promise<At> => {
    const up = await fake.up(NAME, SPEC);
    return { name: NAME, sessionId: up.sessionId };
  };
  const stoppedFake = async (fake: FakeSandboxes): Promise<At> => {
    const at = await runningFake(fake);
    await fake.stop(at);
    return at;
  };
  const upAgain = (sandboxes: Sandboxes, at: At, spec = SPEC) =>
    outcome(sandboxes.up(NAME, spec), (up) => ({
      ...upSummary(up),
      same: up.sessionId === at.sessionId,
    }));

  const cases: Case[] = [
    {
      name: "up on a running sandbox is that session, wasRunning",
      fake: runningFake,
      replay: () => server(["GET", SANDBOX, reply(RUNNING)]).fetch,
      check: (sandboxes, at) => upAgain(sandboxes, at),
      expected: { fresh: true, recreated: false, wasRunning: true, same: true },
    },
    {
      name: "up on a stopped sandbox resumes a new session on its disk",
      fake: stoppedFake,
      replay: () =>
        (async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          return url.searchParams.get("resume") === "true" ? reply(RESUMED) : reply(STOPPED);
        }) as typeof globalThis.fetch,
      check: (sandboxes, at) => upAgain(sandboxes, at),
      expected: { fresh: false, recreated: false, wasRunning: false, same: false },
    },
    {
      name: "up on another digest deletes and creates, without a resume",
      fake: stoppedFake,
      replay: () =>
        server(
          ["GET", SANDBOX, reply(STOPPED)],
          ["DELETE", SANDBOX, reply(DELETED)],
          [
            "POST",
            CREATE,
            reply(CREATED, (body) => {
              body.sandbox.image = `northbrook/ponzu-api/${OTHER_IMAGE}`;
            }),
          ],
        ).fetch,
      check: (sandboxes) => outcome(sandboxes.up(NAME, { ...SPEC, image: OTHER_IMAGE }), upSummary),
      expected: { fresh: true, recreated: true, wasRunning: false },
    },
    {
      name: "stop on a session that already stopped is stopped:false",
      fake: stoppedFake,
      replay: () => server(["GET", SANDBOX, reply(STOPPED)]).fetch,
      check: (sandboxes, at) => outcome(sandboxes.stop(at), (value) => value),
      expected: { stopped: false, snapshotBytes: null },
    },
    {
      name: "a pinned call on a stopped session is not_running; extend is null",
      fake: stoppedFake,
      replay: () => server(["GET", SANDBOX, reply(STOPPED)]).fetch,
      check: async (sandboxes, at) => ({
        exec: await outcome(sandboxes.exec(at, { cmd: "true", timeoutMs: 1_000 }), () => "ran"),
        start: await outcome(sandboxes.start(at, { cmd: "true" }), () => "ran"),
        read: await outcome(sandboxes.readFile(at, "/x"), () => "read"),
        extend: await outcome(sandboxes.extend(at, 1_000), (value) => value),
      }),
      expected: {
        exec: { error: "not_running" },
        start: { error: "not_running" },
        read: { error: "not_running" },
        extend: null,
      },
    },
    {
      name: "a pinned call on a session that is not the current one is not_running",
      fake: async (fake) => {
        const at = await stoppedFake(fake);
        await fake.up(NAME, SPEC);
        return at;
      },
      replay: () => server(["GET", SANDBOX, reply(RESUMED_RUNNING)]).fetch,
      check: async (sandboxes, at) => ({
        exec: await outcome(sandboxes.exec(at, { cmd: "true", timeoutMs: 1_000 }), () => "ran"),
        stop: await outcome(sandboxes.stop(at), (value) => value),
      }),
      expected: { exec: { error: "not_running" }, stop: { stopped: false, snapshotBytes: null } },
    },
    {
      name: "an extend past the 24-hour cap is rejected",
      fake: runningFake,
      replay: () =>
        server(
          ["GET", SANDBOX, reply(RUNNING)],
          ["POST", session(FIRST, "extend-timeout"), reply(PAST_CAP)],
        ).fetch,
      check: (sandboxes, at) => outcome(sandboxes.extend(at, 25 * 3600_000), (value) => value),
      expected: { error: "rejected" },
    },
    {
      name: "128 KB in one variable of a command's env is rejected",
      fake: runningFake,
      replay: () =>
        server(
          ["GET", SANDBOX, reply(RUNNING)],
          ["POST", session(FIRST, "cmd"), reply(exchange("env_128k", "POST", "/cmd"))],
        ).fetch,
      check: (sandboxes, at) =>
        outcome(sandboxes.exec(at, { cmd: "sh", env: { BIG }, timeoutMs: 1_000 }), () => "ran"),
      expected: { error: "rejected" },
    },
    {
      name: "remove of a missing name is success, and status is null",
      fake: async () => ({ name: NAME, sessionId: FIRST }),
      replay: () => server(["GET", SANDBOX, reply(MISSING)]).fetch,
      check: async (sandboxes) => ({
        remove: await outcome(sandboxes.remove(NAME), () => "ok"),
        status: await sandboxes.status(NAME),
      }),
      expected: { remove: "ok", status: null },
    },
  ];

  for (const each of cases) {
    test(each.name, async () => {
      const fake = new FakeSandboxes(new FakeClock());
      expect(await each.check(fake, await each.fake(fake))).toEqual(each.expected);
      const replayed = make(each.replay());
      expect(await each.check(replayed, { name: NAME, sessionId: FIRST })).toEqual(each.expected);
    });
  }

  test("a waited command a stop cuts off resolves with 143, as recorded", async () => {
    const live = (await Bun.file(join(import.meta.dir, "fixtures", "vercel-live.json")).json()) as {
      found: { execCutByStop: { value: { exitCode: number } } };
    };
    const fake = new FakeSandboxes(new FakeClock());
    const at = await runningFake(fake);
    fake.onExec("sleep", () => new Promise(() => {}));
    const cut = fake.exec(at, { cmd: "sleep", timeoutMs: 60_000 });
    await fake.stop(at);
    expect((await cut).exitCode).toBe(live.found.execCutByStop.value.exitCode);
  });
});

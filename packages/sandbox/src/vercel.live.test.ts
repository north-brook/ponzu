/*
 * One pass over real Vercel sandboxes, through the module and, where the module has no call for
 * it, the SDK directly. Opt-in, because it costs money (under $0.02) and needs the token triple:
 *
 *   PONZU_LIVE_VERCEL=1 VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *     bun test packages/sandbox/src/vercel.live.test.ts
 *
 * Optional: PONZU_LIVE_IMAGE (default: apps/runner/image/current.json's image) and
 * PONZU_LIVE_UNREADY_IMAGE, an image pushed seconds ago and not Ready yet, to record
 * image_not_ready.
 *
 * It records every HTTP exchange (no request headers, so no token; command env values replaced
 * by their sizes; team and project ids replaced) and what it found into
 * fixtures/vercel-live.json, which vercel.test.ts replays. Every sandbox it makes is named
 * pz-test-live-*, and it removes them all, then checks list("pz-test-live-") is empty.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { APIError, Sandbox } from "@vercel/sandbox";
import { systemClock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import { testSandboxName } from "./names.ts";
import type { At, Sandboxes, SandboxSpec } from "./sandboxes.ts";
import { vercelSandboxes } from "./vercel.ts";

const token = process.env.VERCEL_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;
const projectId = process.env.VERCEL_PROJECT_ID;
const live = process.env.PONZU_LIVE_VERCEL === "1" && Boolean(token && teamId && projectId);
const FIXTURES = join(import.meta.dir, "fixtures", "vercel-live.json");
const PORT = 4600;

interface Exchange {
  step: string;
  method: string;
  path: string;
  query: Record<string, string>;
  request?: unknown;
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

const KEPT_QUERY = ["resume", "namePrefix", "sortBy", "deleteOrphanSnapshots", "cursor", "limit"];

function redact(text: string): string {
  let out = text;
  for (const secret of [token, teamId, projectId]) {
    if (secret) out = out.split(secret).join(secret === token ? "<token>" : "<id>");
  }
  return out;
}

function recorder() {
  const exchanges: Exchange[] = [];
  let step = "setup";
  const recorded: typeof globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const started = performance.now();
    const response = await globalThis.fetch(input, init);
    const body = await response.clone().text();
    let request: unknown;
    if (typeof init?.body === "string") {
      try {
        const json = JSON.parse(init.body);
        if (json && typeof json === "object" && json.env && typeof json.env === "object") {
          json.env = Object.fromEntries(
            Object.entries(json.env as Record<string, string>).map(([k, v]) => [
              k,
              `<${v.length} chars>`,
            ]),
          );
        }
        request = json;
      } catch {
        request = `<${init.body.length} chars>`;
      }
    }
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    exchanges.push({
      step,
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries([...url.searchParams].filter(([key]) => KEPT_QUERY.includes(key))),
      ...(request === undefined ? {} : { request: JSON.parse(redact(JSON.stringify(request))) }),
      status: response.status,
      headers,
      body: redact(body.length > 20_000 ? `${body.slice(0, 20_000)}…` : body),
      ms: Math.round(performance.now() - started),
    });
    return response;
  }) as typeof globalThis.fetch;
  return {
    fetch: recorded,
    exchanges,
    step(name: string) {
      step = name;
    },
  };
}

async function liveImage(): Promise<string> {
  if (process.env.PONZU_LIVE_IMAGE) return process.env.PONZU_LIVE_IMAGE;
  const current = await Bun.file(
    join(import.meta.dir, "../../../apps/runner/image/current.json"),
  ).json();
  return current.image as string;
}

function failure(error: unknown) {
  if (error instanceof SandboxError) {
    const cause = error.cause;
    return {
      sandboxError: error.code,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
      message: redact(error.message),
      ...(cause instanceof APIError
        ? { status: cause.response.status, json: cause.json ?? null }
        : { causeName: cause instanceof Error ? cause.name : null }),
    };
  }
  if (error instanceof APIError) {
    return {
      status: error.response.status,
      json: error.json ?? null,
      message: redact(error.message),
    };
  }
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: redact(String(error)),
  };
}

async function outcome<T>(work: () => Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    return { ok: false as const, error: failure(error) };
  }
}

async function fetchPort(url: string, bearer?: string) {
  // A port that just came up can answer 502 for a moment (spike).
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${url}/health`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if ((response.status === 502 || response.status === 503) && attempt < 40) {
      await Bun.sleep(250);
      continue;
    }
    return { status: response.status, attempts: attempt + 1 };
  }
}

const SERVER = `
Bun.serve({
  port: ${PORT},
  hostname: "0.0.0.0",
  fetch(request) {
    const ok = request.headers.get("authorization") === "Bearer " + process.env.PORT_TOKEN;
    return new Response(ok ? "ok" : "no", { status: ok ? 200 : 401 });
  },
});
`;

// After SIGTERM it keeps writing the time until something kills it harder.
const GRACE = `mkdir -p /vercel/grace
trap 'date +%s%3N > /vercel/grace/term; sync; while :; do date +%s%3N > /vercel/grace/last; sync; sleep 0.05; done' TERM
while :; do sleep 0.05; done`;

test.skipIf(!live)(
  "vercel sandboxes, live: up, pinned calls, stop, resume, drift, extend, env, names, errors",
  async () => {
    const rec = recorder();
    const credentials = { token: token!, teamId: teamId!, projectId: projectId! };
    const sandboxes: Sandboxes = vercelSandboxes({
      clock: systemClock,
      credentials,
      fetch: rec.fetch,
    });
    const image = await liveImage();
    const made = new Set<string>();
    const found: Record<string, unknown> = { sdk: "3.9.1", image };
    const timings: Record<string, number> = {};
    const timed = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
      rec.step(what);
      const started = performance.now();
      try {
        return await work();
      } finally {
        timings[what] = Math.round(performance.now() - started);
      }
    };
    const raw = { ...credentials, fetch: rec.fetch };

    const name = testSandboxName("live");
    made.add(name);
    const spec: SandboxSpec = {
      image,
      persistent: true,
      timeoutMs: 5 * 60_000,
      ports: [PORT],
      vcpus: 2,
      snapshotExpirationMs: 24 * 3600_000,
    };

    try {
      // ── image_not_ready, when an unready image is given
      const unready = process.env.PONZU_LIVE_UNREADY_IMAGE;
      if (unready) {
        const notReady = testSandboxName("live");
        made.add(notReady);
        rec.step("image_not_ready");
        // Through the module first, then raw creates each second until one succeeds.
        found.imageNotReadyUp = await outcome(() =>
          sandboxes.up(notReady, { ...spec, image: unready, persistent: false, ports: [] }),
        );
        const tries: unknown[] = [];
        const since = performance.now();
        while (
          !(found.imageNotReadyUp as { ok: boolean }).ok &&
          performance.now() - since < 120_000
        ) {
          const result = await outcome(() =>
            Sandbox.create({
              ...raw,
              name: notReady,
              image: unready,
              persistent: false,
              region: "iad1",
            }),
          );
          tries.push(
            result.ok ? { ok: true, afterMs: Math.round(performance.now() - since) } : result.error,
          );
          if (result.ok) break;
          await Bun.sleep(1_000);
        }
        found.imageNotReadyRaw = tries;
      }

      // ── a tag that does not exist in the repository
      const noTag = testSandboxName("live");
      made.add(noTag);
      rec.step("unknown_tag");
      found.unknownTag = await outcome(() =>
        Sandbox.create({
          ...raw,
          name: noTag,
          image: image.replace(/@sha256:[0-9a-f]{64}$/, ":pz-test-none"),
          persistent: false,
          region: "iad1",
        }),
      );

      // ── create
      const first = await timed("up_create", () => sandboxes.up(name, spec));
      expect(first.fresh).toBe(true);
      expect(first.recreated).toBe(false);
      expect(first.wasRunning).toBe(false);
      expect(first.urls[PORT]).toStartWith("https://");
      found.createdUp = { ...first, urls: Object.keys(first.urls) };
      const at: At = { name, sessionId: first.sessionId };

      // ── up on a running sandbox: same session, no update, no resume
      const patchesBefore = rec.exchanges.filter((e) => e.method === "PATCH").length;
      const again = await timed("up_running", () => sandboxes.up(name, spec));
      expect(again.sessionId).toBe(first.sessionId);
      expect(again.wasRunning).toBe(true);
      expect(rec.exchanges.filter((e) => e.method === "PATCH").length).toBe(patchesBefore);
      found.noDriftAfterCreate = true;

      // ── a port behind a bearer
      await timed("write_server", () => sandboxes.writeFile(at, "/vercel/live-server.ts", SERVER));
      const started = await timed("start_server", () =>
        sandboxes.start(at, {
          cmd: "/opt/ponzu/bin/bun",
          args: ["/vercel/live-server.ts"],
          env: { PORT_TOKEN: "live-port-token" },
        }),
      );
      expect(started.commandId).toBeString();
      const withBearer = await timed("port_bearer", () =>
        fetchPort(first.urls[PORT]!, "live-port-token"),
      );
      const withoutBearer = await fetchPort(first.urls[PORT]!);
      expect(withBearer.status).toBe(200);
      expect(withoutBearer.status).toBe(401);
      found.port = { withBearer, withoutBearer };

      // ── pinned exec
      const ran = await timed("exec", () =>
        sandboxes.exec(at, {
          cmd: "sh",
          args: ["-c", "echo out; echo err >&2; exit 3"],
          timeoutMs: 30_000,
        }),
      );
      expect(ran).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
      const sudo = await sandboxes.exec(at, {
        cmd: "id",
        args: ["-u"],
        sudo: true,
        timeoutMs: 30_000,
      });
      found.sudoUid = sudo.stdout.trim();

      // ── a 64 KB command env, and twice that to see where it stops
      for (const kb of [64, 128]) {
        const big = "x".repeat(kb * 1024);
        const result = await timed(`env_${kb}k`, () =>
          outcome(() =>
            sandboxes.exec(at, {
              cmd: "sh",
              args: ["-c", 'printf %s "$BIG" | wc -c'],
              env: { BIG: big },
              timeoutMs: 30_000,
            }),
          ),
        );
        found[`env${kb}k`] = result.ok
          ? { accepted: true, bytes: result.value.stdout.trim() }
          : result.error;
      }
      expect(found.env64k).toEqual({ accepted: true, bytes: String(64 * 1024) });

      // ── files
      await sandboxes.writeFile(at, "/vercel/kept.txt", "kept across a stop");
      const back = await sandboxes.readFile(at, "/vercel/kept.txt");
      expect(new TextDecoder().decode(back!)).toBe("kept across a stop");
      expect(await sandboxes.readFile(at, "/vercel/missing.txt")).toBeNull();

      // ── extend, read back; and past the 24 h cap
      const extended = await timed("extend", () => sandboxes.extend(at, 60_000));
      expect(extended).toBe(first.expiresAt + 60_000);
      found.extendPastCap = await timed("extend_past_cap", () =>
        outcome(() => sandboxes.extend(at, 25 * 3600_000)),
      );

      // ── duplicate-name create, while the name exists
      found.duplicateCreate = await timed("duplicate_create", () =>
        outcome(() =>
          Sandbox.create({ ...raw, name, image, persistent: true, ports: [PORT], region: "iad1" }),
        ),
      );

      // ── the SIGTERM grace of stop(), and a waited command cut off by it
      await sandboxes.start(at, { cmd: "bash", args: ["-c", GRACE] });
      await Bun.sleep(1_000);
      rec.step("exec_during_stop");
      const during = outcome(() =>
        sandboxes.exec(at, { cmd: "sleep", args: ["60"], timeoutMs: 120_000 }),
      );
      await Bun.sleep(1_000);
      const stopped = await timed("stop", () => sandboxes.stop(at));
      expect(stopped.stopped).toBe(true);
      found.stop = stopped;
      found.execCutByStop = await during;

      // ── after the stop: stays stopped, pinned calls are not_running and resume nothing
      const afterStop = await sandboxes.status(name);
      expect(afterStop?.status).toBe("stopped");
      rec.step("pinned_after_stop_cached");
      found.execAfterStopCached = await outcome(() =>
        sandboxes.exec(at, { cmd: "true", timeoutMs: 10_000 }),
      );
      rec.step("pinned_after_stop_uncached");
      const cold = vercelSandboxes({ clock: systemClock, credentials, fetch: rec.fetch });
      found.execAfterStopUncached = await outcome(() =>
        cold.exec(at, { cmd: "true", timeoutMs: 10_000 }),
      );
      rec.step("stop_again");
      found.stopAgain = await outcome(() => sandboxes.stop(at));
      rec.step("raw_stop_again");
      found.rawStopAgain = await outcome(async () => {
        const sandbox = await Sandbox.get({ ...raw, name, resume: false });
        return (await sandbox.currentSession().stop()).session.status;
      });
      found.extendAfterStop = await outcome(() => sandboxes.extend(at, 60_000));
      expect(found.execAfterStopCached).toMatchObject({
        ok: false,
        error: { sandboxError: "not_running" },
      });
      expect(found.execAfterStopUncached).toMatchObject({
        ok: false,
        error: { sandboxError: "not_running" },
      });
      expect(found.stopAgain).toEqual({ ok: true, value: { stopped: false, snapshotBytes: null } });
      expect(found.extendAfterStop).toEqual({ ok: true, value: null });
      await Bun.sleep(5_000);
      expect((await sandboxes.status(name))?.status).toBe("stopped");

      // ── drift, then resume: update first (status still stopped), new session, files kept
      const drifted = { ...spec, timeoutMs: 6 * 60_000 };
      const resumed = await timed("up_drift_resume", () => sandboxes.up(name, drifted));
      const patch = rec.exchanges.find((e) => e.step === "up_drift_resume" && e.method === "PATCH");
      expect(patch).toBeDefined();
      const patchedStatus = JSON.parse(patch!.body).sandbox.status;
      found.statusAfterUpdate = patchedStatus;
      expect(patchedStatus).toBe("stopped");
      expect(resumed.sessionId).not.toBe(first.sessionId);
      expect(resumed.fresh).toBe(false);
      expect(resumed.wasRunning).toBe(false);
      expect(resumed.expiresAt - resumed.startedAt).toBe(6 * 60_000);
      found.resumedUp = { ...resumed, urls: Object.keys(resumed.urls) };
      const at2: At = { name, sessionId: resumed.sessionId };
      // A resumed session also routes Vercel's interactive port: still no drift.
      rec.step("up_resumed_running");
      const resumedAgain = await sandboxes.up(name, drifted);
      expect(resumedAgain).toMatchObject({ sessionId: resumed.sessionId, wasRunning: true });
      expect(
        rec.exchanges.some((e) => e.step === "up_resumed_running" && e.method === "PATCH"),
      ).toBe(false);
      const kept = await sandboxes.readFile(at2, "/vercel/kept.txt");
      expect(new TextDecoder().decode(kept!)).toBe("kept across a stop");
      const procs = await sandboxes.exec(at2, {
        cmd: "sh",
        args: [
          "-c",
          "ps -eo args | grep -c '^/opt/ponzu/bin/bun /vercel/live-server' || true; cat /vercel/grace/term /vercel/grace/last",
        ],
        timeoutMs: 30_000,
      });
      const [survivors, term, last] = procs.stdout.trim().split("\n").map(Number) as [
        number,
        number,
        number,
      ];
      expect(survivors).toBe(0); // processes do not survive a stop
      found.sigtermGraceMs = last - term;
      found.sigtermToStopAnswerNote =
        "grace = last write after SIGTERM minus SIGTERM time, written and synced every 50 ms";

      // ── a different digest: delete without booting, then create (fails: no such image)
      rec.step("up_other_digest");
      const otherDigest = image.replace(/sha256:[0-9a-f]{64}$/, `sha256:${"0".repeat(64)}`);
      found.upUnknownDigest = await outcome(() =>
        sandboxes.up(name, { ...spec, image: otherDigest }),
      );
      expect(
        rec.exchanges.some((e) => e.step === "up_other_digest" && e.query.resume === "true"),
      ).toBe(false);
      found.statusAfterUnknownDigest = await sandboxes.status(name);

      // ── delete, then create the same name at once
      const reuse = testSandboxName("live");
      made.add(reuse);
      await timed("reuse_create", () =>
        Sandbox.create({ ...raw, name: reuse, image, persistent: false, region: "iad1" }),
      );
      rec.step("reuse_delete_create");
      const doomed = await Sandbox.get({ ...raw, name: reuse, resume: false });
      await doomed.delete({ deleteOrphanSnapshots: true });
      const deletedAt = performance.now();
      const reused: unknown[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = await outcome(() =>
          Sandbox.create({ ...raw, name: reuse, image, persistent: false, region: "iad1" }),
        );
        reused.push(
          result.ok
            ? { ok: true, afterMs: Math.round(performance.now() - deletedAt) }
            : result.error,
        );
        if (result.ok) break;
        await Bun.sleep(500);
      }
      found.nameReuseAfterDelete = reused;

      // ── the sign-in shape: not persistent, no ports
      const signIn = testSandboxName("live");
      made.add(signIn);
      const signInSpec: SandboxSpec = {
        image,
        persistent: false,
        timeoutMs: 5 * 60_000,
        ports: [],
      };
      const ephemeral = await timed("up_ephemeral", () => sandboxes.up(signIn, signInSpec));
      rec.step("up_ephemeral_again");
      const ephemeralAgain = await sandboxes.up(signIn, signInSpec);
      expect(ephemeralAgain.wasRunning).toBe(true);
      expect(
        rec.exchanges.some((e) => e.step === "up_ephemeral_again" && e.method === "PATCH"),
      ).toBe(false);
      found.ephemeralUp = { ...ephemeral, urls: Object.keys(ephemeral.urls) };

      // ── list
      rec.step("list");
      const listed = await sandboxes.list("pz-test-live-");
      found.listed = listed.map((info) => ({
        ...info,
        name: info.name.replace(/-[a-z0-9]{8}$/, "-*"),
      }));
      expect(listed.map((info) => info.name)).toContain(signIn);
    } catch (error) {
      found.failedAt = { step: rec.exchanges.at(-1)?.step ?? null, error: failure(error) };
      console.error("live run failed:", redact(String(error)));
      throw error;
    } finally {
      rec.step("cleanup");
      for (const each of made) {
        found[`remove_${[...made].indexOf(each)}`] = await outcome(() => sandboxes.remove(each));
      }
      rec.step("cleanup_list");
      const left = await sandboxes.list("pz-test-live-");
      found.leftAfterCleanup = left.map((info) => info.name);
      found.timings = timings;
      await Bun.write(
        FIXTURES,
        `${JSON.stringify(
          { recordedAt: new Date().toISOString(), found, exchanges: rec.exchanges },
          (_key, value) =>
            value instanceof Sandbox ? { sandbox: value.name, status: value.status } : value,
          2,
        )}\n`,
      );
      expect(left).toEqual([]);
    }
  },
  600_000,
);

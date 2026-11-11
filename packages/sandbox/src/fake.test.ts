import { describe, expect, test } from "bun:test";
import { FakeClock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import { FakeSandboxes } from "./fake.ts";
import type { At, SandboxSpec } from "./sandboxes.ts";

const IMAGE = `ponzu-runner@sha256:${"a".repeat(64)}`;
const OTHER = `ponzu-runner@sha256:${"b".repeat(64)}`;
const SPEC: SandboxSpec = {
  image: IMAGE,
  persistent: true,
  timeoutMs: 30 * 60_000,
  ports: [4600],
  vcpus: 2,
  snapshotExpirationMs: 30 * 24 * 3600_000,
};
const NAME = "pz-0123456789ab-design1";
const text = (bytes: Uint8Array | null | undefined) =>
  bytes ? new TextDecoder().decode(bytes) : null;

function setup() {
  const clock = new FakeClock();
  return { clock, sandboxes: new FakeSandboxes(clock) };
}

async function notRunning(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SandboxError);
  expect((error as SandboxError).code).toBe("not_running");
}

describe("FakeSandboxes", () => {
  test("up creates a fresh sandbox with a running session and a URL per port", async () => {
    const { clock, sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    expect(up).toMatchObject({ name: NAME, fresh: true, recreated: false, wasRunning: false });
    expect(up.expiresAt).toBe(up.startedAt + SPEC.timeoutMs);
    expect(up.startedAt).toBe(clock.now());
    expect(up.urls[4600]).toStartWith("https://");
    expect(up.image).toEndWith(IMAGE.slice("ponzu-runner".length));
    expect(sandboxes.resumes(NAME)).toBe(0);
    expect((await sandboxes.status(NAME))?.status).toBe("running");
  });

  test("names are unique: a second up on a running sandbox is the same session, wasRunning", async () => {
    const { sandboxes } = setup();
    const first = await sandboxes.up(NAME, SPEC);
    const again = await sandboxes.up(NAME, SPEC);
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.wasRunning).toBe(true);
    expect(await sandboxes.list("pz-")).toHaveLength(1);
    expect(sandboxes.config(NAME).updates).toBe(0);
  });

  test("a stop then up: new session, files kept, processes and commands gone, one resume", async () => {
    const { sandboxes } = setup();
    const first = await sandboxes.up(NAME, SPEC);
    const at: At = { name: NAME, sessionId: first.sessionId };
    await sandboxes.writeFile(at, "/vercel/a.txt", "kept");
    await sandboxes.start(at, { cmd: "/opt/ponzu/bin/ponzu-start", sudo: true });
    const stopped = await sandboxes.stop(at);
    expect(stopped.stopped).toBe(true);
    expect(stopped.snapshotBytes).toBe(4);
    expect((await sandboxes.status(NAME))?.status).toBe("stopped");

    const second = await sandboxes.up(NAME, SPEC);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).toMatchObject({ fresh: false, wasRunning: false, recreated: false });
    expect(sandboxes.resumes(NAME)).toBe(1);
    const at2 = { name: NAME, sessionId: second.sessionId };
    expect(text(await sandboxes.readFile(at2, "/vercel/a.txt"))).toBe("kept");
    // The start belonged to the old session.
    expect(sandboxes.commands(NAME).map((each) => each.sessionId)).toEqual([first.sessionId]);
  });

  test("pinned calls on another session, or a stopped one, are not_running and resume nothing", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    const at = { name: NAME, sessionId: up.sessionId };
    await notRunning(
      sandboxes.exec({ name: NAME, sessionId: "sbx_other" }, { cmd: "true", timeoutMs: 1 }),
    );
    await sandboxes.stop(at);
    await notRunning(sandboxes.exec(at, { cmd: "true", timeoutMs: 1 }));
    await notRunning(sandboxes.start(at, { cmd: "true" }));
    await notRunning(sandboxes.writeFile(at, "/x", "x"));
    await notRunning(sandboxes.readFile(at, "/x"));
    await notRunning(
      sandboxes.exec(
        { name: "pz-0123456789ab-missing", sessionId: "s" },
        { cmd: "true", timeoutMs: 1 },
      ),
    );
    expect(await sandboxes.extend(at, 60_000)).toBeNull();
    expect(await sandboxes.stop(at)).toEqual({ stopped: false, snapshotBytes: null });
    expect(sandboxes.resumes(NAME)).toBe(0);
    expect((await sandboxes.status(NAME))?.status).toBe("stopped");
  });

  test("a session stops by itself at its deadline; extend moves the deadline, capped at 24 h", async () => {
    const { clock, sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    const at = { name: NAME, sessionId: up.sessionId };
    expect(await sandboxes.extend(at, 20 * 60_000)).toBe(up.expiresAt + 20 * 60_000);
    const error = await sandboxes.extend(at, 24 * 3600_000).catch((caught) => caught);
    expect((error as SandboxError).code).toBe("rejected");
    clock.advance(SPEC.timeoutMs + 20 * 60_000);
    expect((await sandboxes.status(NAME))?.status).toBe("stopped");
    await notRunning(sandboxes.exec(at, { cmd: "true", timeoutMs: 1 }));
  });

  test("an image change deletes and recreates: an empty disk, no resume", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    await sandboxes.writeFile({ name: NAME, sessionId: up.sessionId }, "/vercel/a", "old");
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    const moved = await sandboxes.up(NAME, { ...SPEC, image: OTHER });
    expect(moved).toMatchObject({ fresh: true, recreated: true, wasRunning: false });
    expect(sandboxes.files(NAME).size).toBe(0);
    expect(sandboxes.resumes(NAME)).toBe(0);
    expect(sandboxes.config(NAME).image).toEndWith(OTHER.slice("ponzu-runner".length));
  });

  test("drift is recorded as one update and applies from the next session", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    const longer = { ...SPEC, timeoutMs: 45 * 60_000, vcpus: 4 as const };
    const next = await sandboxes.up(NAME, longer);
    expect(sandboxes.config(NAME)).toMatchObject({
      updates: 1,
      spec: { timeoutMs: 45 * 60_000, vcpus: 4 },
    });
    expect(next.expiresAt - next.startedAt).toBe(45 * 60_000);
    await sandboxes.up(NAME, longer);
    expect(sandboxes.config(NAME).updates).toBe(1);
  });

  test("drift on a running sandbox keeps its session's timeout until the next one", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    const again = await sandboxes.up(NAME, { ...SPEC, timeoutMs: 60 * 60_000 });
    expect(again.wasRunning).toBe(true);
    expect(again.expiresAt).toBe(up.expiresAt);
    expect(sandboxes.config(NAME).updates).toBe(1);
  });

  test("expire: the next up is a fresh disk under the same name", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    await sandboxes.writeFile({ name: NAME, sessionId: up.sessionId }, "/vercel/a", "x");
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    sandboxes.expire(NAME);
    const next = await sandboxes.up(NAME, SPEC);
    expect(next).toMatchObject({ fresh: true, recreated: false, wasRunning: false });
    expect(sandboxes.files(NAME).size).toBe(0);
  });

  test("retain: Vercel removed it, so the next up is a create (fresh), not a resume", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    sandboxes.retain(NAME);
    expect(await sandboxes.status(NAME)).toBeNull();
    const next = await sandboxes.up(NAME, SPEC);
    expect(next).toMatchObject({ fresh: true, recreated: false, wasRunning: false });
    expect(sandboxes.resumes(NAME)).toBe(0);
  });

  test("lose: the session fails and the next up boots the stop before the last", async () => {
    const { sandboxes } = setup();
    let up = await sandboxes.up(NAME, SPEC);
    await sandboxes.writeFile({ name: NAME, sessionId: up.sessionId }, "/vercel/v", "1");
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    up = await sandboxes.up(NAME, SPEC);
    await sandboxes.writeFile({ name: NAME, sessionId: up.sessionId }, "/vercel/v", "2");
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    up = await sandboxes.up(NAME, SPEC);
    sandboxes.lose(NAME);
    expect((await sandboxes.status(NAME))?.status).toBe("failed");
    const next = await sandboxes.up(NAME, SPEC);
    expect(
      text(await sandboxes.readFile({ name: NAME, sessionId: next.sessionId }, "/vercel/v")),
    ).toBe("1");
  });

  test("resumeBehindOurBack: a session we did not start; up then reports wasRunning", async () => {
    const { sandboxes } = setup();
    const up = await sandboxes.up(NAME, SPEC);
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    sandboxes.resumeBehindOurBack(NAME);
    const info = await sandboxes.status(NAME);
    expect(info?.status).toBe("running");
    expect(info?.sessionId).not.toBe(up.sessionId);
    expect(sandboxes.resumes(NAME)).toBe(1);
    const next = await sandboxes.up(NAME, SPEC);
    expect(next.wasRunning).toBe(true);
    expect(next.sessionId).toBe(info!.sessionId!);
    expect(sandboxes.resumes(NAME)).toBe(1);
  });

  test("a non-persistent sandbox loses its disk at every stop", async () => {
    const { sandboxes } = setup();
    const spec = { image: IMAGE, persistent: false, timeoutMs: 15 * 60_000, ports: [] };
    const up = await sandboxes.up("pz-0123456789ab-signin-a1", spec);
    const at = { name: up.name, sessionId: up.sessionId };
    await sandboxes.writeFile(at, "/tmp/driver", "x");
    expect((await sandboxes.stop(at)).snapshotBytes).toBeNull();
    const next = await sandboxes.up(up.name, spec);
    expect(next.fresh).toBe(true);
    expect(next.urls).toEqual({});
  });

  test("failNext fails one call of one op on one name, with its code", async () => {
    const { sandboxes } = setup();
    sandboxes.failNext("up", NAME, "rate_limited", 7);
    const error = (await sandboxes.up(NAME, SPEC).catch((caught) => caught)) as SandboxError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
    const up = await sandboxes.up(NAME, SPEC);
    sandboxes.failNext("exec", NAME, "unavailable");
    const failed = await sandboxes
      .exec({ name: NAME, sessionId: up.sessionId }, { cmd: "true", timeoutMs: 1 })
      .catch((caught) => caught);
    expect((failed as SandboxError).code).toBe("unavailable");
    expect(
      await sandboxes.exec({ name: NAME, sessionId: up.sessionId }, { cmd: "true", timeoutMs: 1 }),
    ).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("onExec answers a command; commands records env and sudo per session", async () => {
    const { sandboxes } = setup();
    sandboxes.onExec("/opt/ponzu/bin/ponzu-stop", () => ({
      exitCode: 0,
      stdout: "stopped\n",
      stderr: "",
    }));
    const up = await sandboxes.up(NAME, SPEC);
    const at = { name: NAME, sessionId: up.sessionId };
    await sandboxes.start(at, { cmd: "/opt/ponzu/bin/ponzu-start", env: { A: "1" }, sudo: true });
    const result = await sandboxes.exec(at, {
      cmd: "/opt/ponzu/bin/ponzu-stop",
      sudo: true,
      timeoutMs: 30_000,
    });
    expect(result.stdout).toBe("stopped\n");
    expect(sandboxes.commands(NAME)).toEqual([
      {
        sessionId: up.sessionId,
        kind: "start",
        command: { cmd: "/opt/ponzu/bin/ponzu-start", env: { A: "1" }, sudo: true },
      },
      {
        sessionId: up.sessionId,
        kind: "exec",
        command: { cmd: "/opt/ponzu/bin/ponzu-stop", sudo: true },
      },
    ]);
  });

  test("list filters by prefix and sorts by name; remove is idempotent", async () => {
    const { sandboxes } = setup();
    await sandboxes.up("pz-0123456789ab-b", SPEC);
    await sandboxes.up("pz-0123456789ab-a", SPEC);
    await sandboxes.up("pz-ffffffffffff-c", SPEC);
    expect((await sandboxes.list("pz-0123456789ab-")).map((each) => each.name)).toEqual([
      "pz-0123456789ab-a",
      "pz-0123456789ab-b",
    ]);
    await sandboxes.remove("pz-0123456789ab-a");
    await sandboxes.remove("pz-0123456789ab-a");
    expect((await sandboxes.list("pz-")).map((each) => each.name)).toEqual([
      "pz-0123456789ab-b",
      "pz-ffffffffffff-c",
    ]);
  });

  test("time: creates, resumes and stops take what the options say", async () => {
    const clock = new FakeClock();
    const sandboxes = new FakeSandboxes(clock, { createMs: 1_000, resumeMs: 2_000, stopMs: 3_000 });
    const t0 = clock.now();
    const up = await sandboxes.up(NAME, SPEC);
    expect(clock.now() - t0).toBe(1_000);
    await sandboxes.stop({ name: NAME, sessionId: up.sessionId });
    expect(clock.now() - t0).toBe(4_000);
    await sandboxes.up(NAME, SPEC);
    expect(clock.now() - t0).toBe(6_000);
  });
});

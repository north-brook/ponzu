import { expect, test } from "bun:test";
import { SandboxError } from "./errors.ts";
import { FakeProvider } from "./fake.ts";
import type { ExecEvent } from "./provider.ts";

const MINUTE = 60_000;

/** A fake with one sandbox, already awake. */
async function awake(options: { env?: Record<string, string>; autoStopSeconds?: number } = {}) {
  const fake = new FakeProvider();
  const { sandbox } = await fake.create({
    idempotencyKey: "design-d1",
    labels: { design: "d1" },
    env: options.env ?? { TOKEN: "t1" },
    autoStopSeconds: options.autoStopSeconds ?? 3600,
  });
  await fake.ensureAwake(sandbox.id);
  return { fake, id: sandbox.id };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SandboxError) return error.code;
    throw error;
  }
  return "no error";
}

test("a new sandbox starts, then is awake", async () => {
  const fake = new FakeProvider();
  const { sandbox, addresses } = await fake.create({
    idempotencyKey: "design-d1",
    labels: { design: "d1" },
    ports: [4500],
    autoStopSeconds: 600,
  });
  expect(sandbox).toMatchObject({
    state: "starting",
    labels: { design: "d1" },
    autoStopAt: fake.clock.now() + 600_000,
  });
  expect(addresses).toHaveLength(1);
  expect(addresses[0]!.url).not.toContain(addresses[0]!.token!);

  fake.clock.advance(2_999);
  expect((await fake.get(sandbox.id)).state).toBe("starting");
  fake.clock.advance(1);
  expect((await fake.get(sandbox.id)).state).toBe("awake");
});

test("a retried create returns the first sandbox, and changed options are a conflict", async () => {
  const fake = new FakeProvider();
  const options = { idempotencyKey: "design-d1", env: { TOKEN: "t1" }, autoStopSeconds: 600 };
  const first = await fake.create(options);
  const again = await fake.create(options);
  expect(again.sandbox.id).toBe(first.sandbox.id);
  expect(await fake.list()).toHaveLength(1);
  expect(await code(fake.create({ ...options, env: { TOKEN: "t2" } }))).toBe("conflict");
});

test("list filters on every label given", async () => {
  const fake = new FakeProvider();
  await fake.create({
    idempotencyKey: "a",
    labels: { design: "d1", env: "dev" },
    autoStopSeconds: 60,
  });
  await fake.create({
    idempotencyKey: "b",
    labels: { design: "d2", env: "dev" },
    autoStopSeconds: 60,
  });
  expect(await fake.list({ labels: { env: "dev" } })).toHaveLength(2);
  expect(await fake.list({ labels: { env: "dev", design: "d2" } })).toHaveLength(1);
  expect(await fake.list({ labels: { design: "d3" } })).toHaveLength(0);
});

test("ensureAwake waits out a first start and reports it cold", async () => {
  const fake = new FakeProvider();
  const { sandbox } = await fake.create({ idempotencyKey: "k", autoStopSeconds: 600 });
  const wake = await fake.ensureAwake(sandbox.id);
  expect(wake).toMatchObject({ start: "cold", ms: 3_000, sandbox: { state: "awake" } });
  expect(await fake.ensureAwake(sandbox.id)).toMatchObject({ start: "none", ms: 0 });
});

test("a resume soon after an explicit stop is warm: processes and /tmp survive", async () => {
  const { fake, id } = await awake();
  await fake.writeFile(id, "/tmp/scratch", "x");
  const { pid } = await fake.spawn(id, "bun run dev");

  expect((await fake.stop(id)).state).toBe("stopping");
  fake.clock.advance(9 * MINUTE);
  expect((await fake.get(id)).state).toBe("asleep");

  const wake = await fake.ensureAwake(id);
  expect(wake).toMatchObject({ start: "warm", ms: 1_000 });
  expect((await fake.process(id, pid)).state).toBe("running");
  expect(new TextDecoder().decode(await fake.readFile(id, "/tmp/scratch"))).toBe("x");
});

test("a resume after the warm window is cold: processes and /tmp are lost, the disk is kept", async () => {
  const { fake, id } = await awake();
  await fake.writeFile(id, "/tmp/scratch", "x");
  await fake.writeFile(id, "repo/README.md", "kept");
  const { pid } = await fake.spawn(id, "bun run dev");

  await fake.stop(id);
  fake.clock.advance(11 * MINUTE);
  const wake = await fake.ensureAwake(id);

  expect(wake).toMatchObject({ start: "cold", ms: 3_000 });
  expect((await fake.process(id, pid)).state).toBe("lost");
  expect(await code(fake.readFile(id, "/tmp/scratch"))).toBe("not_found");
  expect(new TextDecoder().decode(await fake.readFile(id, "/home/user/repo/README.md"))).toBe(
    "kept",
  );
});

test("an auto-stop is never warm, however soon the resume", async () => {
  const { fake, id } = await awake({ autoStopSeconds: 300 });
  // An explicit stop a minute ago, whose warm window is still open.
  await fake.stop(id);
  fake.clock.advance(MINUTE);
  expect((await fake.ensureAwake(id)).start).toBe("warm");

  fake.clock.advance(5 * MINUTE);
  expect(await fake.get(id)).toMatchObject({ state: "asleep", autoStopAt: null });
  expect((await fake.ensureAwake(id)).start).toBe("cold");
});

test("extend pushes the auto-stop out", async () => {
  const { fake, id } = await awake({ autoStopSeconds: 300 });
  fake.clock.advance(4 * MINUTE);
  const extended = await fake.extend(id, 300);
  expect(extended.autoStopAt).toBe(fake.clock.now() + 300_000);
  fake.clock.advance(4 * MINUTE);
  expect((await fake.get(id)).state).toBe("awake");
  fake.clock.advance(MINUTE);
  expect((await fake.get(id)).state).toBe("asleep");
});

test("a new environment forces a cold start and replaces the old one whole", async () => {
  const { fake, id } = await awake({ env: { TOKEN: "t1", KEEP: "no" } });
  expect(await code(fake.resume(id, { env: { TOKEN: "t2" } }))).toBe("conflict");
  expect(fake.env(id)).toEqual({ TOKEN: "t1", KEEP: "no" });

  await fake.stop(id);
  fake.clock.advance(5_000);
  const wake = await fake.ensureAwake(id, { env: { TOKEN: "t2" }, autoStopSeconds: 120 });
  expect(wake.start).toBe("cold");
  expect(fake.env(id)).toEqual({ TOKEN: "t2" });
  expect(wake.sandbox.autoStopAt).toBe(fake.clock.now() - 3_000 + 120_000);
});

test("resuming a sandbox that is still stopping is a conflict, and ensureAwake waits it out", async () => {
  const { fake, id } = await awake();
  await fake.stop(id);
  await expect(fake.resume(id)).rejects.toMatchObject({ code: "conflict", retryAfterSeconds: 2 });
  const wake = await fake.ensureAwake(id);
  expect(wake).toMatchObject({ start: "warm", ms: 2_000 + 1_000 });
});

test("usage meters awake time only, at the size's price", async () => {
  const fake = new FakeProvider();
  const { sandbox } = await fake.create({
    idempotencyKey: "k",
    size: "medium",
    autoStopSeconds: 7200,
  });
  const id = sandbox.id;
  expect(await fake.usage(id)).toEqual({ awakeSeconds: 0, costUsd: 0, awake: false });

  await fake.ensureAwake(id);
  fake.clock.advance(30 * MINUTE);
  await fake.stop(id);
  fake.clock.advance(60 * MINUTE);
  expect(await fake.usage(id)).toEqual({ awakeSeconds: 1800, costUsd: 0.018, awake: false });

  await fake.ensureAwake(id);
  fake.clock.advance(30 * MINUTE);
  expect(await fake.usage(id)).toEqual({ awakeSeconds: 3600, costUsd: 0.036, awake: true });
});

test("an auto-stop ends the meter at the deadline, not when someone next looks", async () => {
  const { fake, id } = await awake({ autoStopSeconds: 600 });
  fake.clock.advance(60 * MINUTE);
  // Awake from the end of the 3 s start until the deadline, 600 s after the create.
  expect((await fake.usage(id)).awakeSeconds).toBe(597);
});

test("an injected failure hits the next call once", async () => {
  const { fake, id } = await awake();
  await fake.stop(id);
  fake.clock.advance(5_000);
  fake.failNext(
    "resume",
    new SandboxError("rate_limited", "start limit full", { retryAfterSeconds: 30 }),
  );
  await expect(fake.ensureAwake(id)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterSeconds: 30,
  });
  expect((await fake.ensureAwake(id)).start).toBe("warm");
});

test("an expired sandbox cannot be resumed", async () => {
  const { fake, id } = await awake();
  await fake.stop(id);
  fake.clock.advance(15 * 24 * 60 * MINUTE);
  fake.expire(id);
  expect(await code(fake.ensureAwake(id))).toBe("snapshot_expired");
  expect((await fake.get(id)).state).toBe("asleep");
});

test("a start that hangs times the wake out", async () => {
  const fake = new FakeProvider();
  fake.startMs.cold = 10 * MINUTE;
  const { sandbox } = await fake.create({ idempotencyKey: "k", autoStopSeconds: 3600 });
  const before = fake.clock.now();
  expect(await code(fake.ensureAwake(sandbox.id, { timeoutMs: 20_000 }))).toBe("unavailable");
  expect(fake.clock.now() - before).toBe(20_000);
});

test("exec records the command with the environment it ran in", async () => {
  const { fake, id } = await awake({ env: { TOKEN: "t1" } });
  fake.onExec = ({ command }) =>
    command.startsWith("git")
      ? { exitCode: 128, stderr: "fatal: not a git repository\n" }
      : undefined;

  expect(await fake.exec(id, "git status", { cwd: "repo" })).toEqual({
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository\n",
    timedOut: false,
    truncated: false,
  });
  expect((await fake.exec(id, "true")).exitCode).toBe(0);
  expect(fake.commands).toEqual([
    { id, command: "git status", cwd: "repo", env: { TOKEN: "t1" }, detached: false },
    { id, command: "true", cwd: undefined, env: { TOKEN: "t1" }, detached: false },
  ]);
});

test("execStream yields the handler's output, then the exit", async () => {
  const { fake, id } = await awake();
  fake.onExec = () => ({ stdout: "building\n", stderr: "warning\n", exitCode: 2 });
  const events: ExecEvent[] = [];
  for await (const event of fake.execStream(id, "bun run build")) events.push(event);
  expect(events).toEqual([
    { type: "stdout", data: "building\n" },
    { type: "stderr", data: "warning\n" },
    { type: "exit", exitCode: 2, timedOut: false },
  ]);
});

test("commands, files and addresses need the sandbox awake", async () => {
  const { fake, id } = await awake();
  await fake.stop(id);
  expect(await code(fake.exec(id, "true"))).toBe("not_running");
  expect(await code(fake.spawn(id, "true"))).toBe("not_running");
  expect(await code(fake.readFile(id, "a"))).toBe("not_running");
  expect(await code(fake.writeFile(id, "a", "b"))).toBe("not_running");
  expect(await code(fake.address(id, 4500))).toBe("not_running");
  expect(fake.commands).toHaveLength(0);
});

test("files round-trip as bytes and are copied, not shared", async () => {
  const { fake, id } = await awake();
  const written = new Uint8Array([0, 255, 128]);
  await fake.writeFile(id, "raw.bin", written);
  written[0] = 7;
  const read = await fake.readFile(id, "/home/user/raw.bin");
  expect(read).toEqual(new Uint8Array([0, 255, 128]));
  read[1] = 7;
  expect(await fake.readFile(id, "raw.bin")).toEqual(new Uint8Array([0, 255, 128]));
  expect(await code(fake.readFile(id, "none.txt"))).toBe("not_found");
});

test("a killed process has exited, and killing it again is fine", async () => {
  const { fake, id } = await awake();
  const { pid } = await fake.spawn(id, "bun run dev", { cwd: "repo" });
  expect((await fake.process(id, pid)).state).toBe("running");
  await fake.kill(id, pid);
  await fake.kill(id, pid);
  expect(await fake.process(id, pid)).toMatchObject({ state: "exited", exitCode: 143 });
  expect((await fake.process(id, 1)).state).toBe("lost");
  expect(fake.commands.at(-1)).toMatchObject({ command: "bun run dev", detached: true });
});

test("an address is stable across sleep and wake", async () => {
  const fake = new FakeProvider();
  const { sandbox, addresses } = await fake.create({
    idempotencyKey: "k",
    ports: [4500],
    autoStopSeconds: 600,
  });
  await fake.ensureAwake(sandbox.id);
  await fake.stop(sandbox.id);
  fake.clock.advance(20 * MINUTE);
  await fake.ensureAwake(sandbox.id);
  expect(await fake.address(sandbox.id, 4500)).toEqual(addresses[0]!);
});

test("a snapshot takes time to save, then new sandboxes start from its files", async () => {
  const { fake, id } = await awake();
  await fake.writeFile(id, "repo/package.json", "{}");

  expect(await fake.saveSnapshot(id, "repo-42")).toMatchObject({
    name: "repo-42",
    state: "saving",
    sandboxId: id,
    sizeBytes: null,
  });
  expect(await code(fake.saveSnapshot(id, "repo-42"))).toBe("conflict");
  expect(
    await code(fake.create({ idempotencyKey: "early", from: "repo-42", autoStopSeconds: 60 })),
  ).toBe("not_found");

  fake.clock.advance(4_000);
  expect(await fake.getSnapshot("repo-42")).toMatchObject({ state: "ready", sizeBytes: 2 });
  expect((await fake.listSnapshots()).map((s) => s.name)).toEqual(["repo-42"]);

  // The snapshot is of that moment: later writes to the source do not reach it.
  await fake.writeFile(id, "repo/package.json", '{"name":"later"}');
  const { sandbox } = await fake.create({
    idempotencyKey: "d2",
    from: "repo-42",
    autoStopSeconds: 60,
  });
  await fake.ensureAwake(sandbox.id);
  expect(new TextDecoder().decode(await fake.readFile(sandbox.id, "repo/package.json"))).toBe("{}");

  await fake.deleteSnapshot("repo-42");
  await fake.deleteSnapshot("repo-42");
  expect(await fake.getSnapshot("repo-42")).toBeNull();
  expect(
    await code(fake.create({ idempotencyKey: "d3", from: "repo-42", autoStopSeconds: 60 })),
  ).toBe("not_found");
});

test("a destroyed sandbox is gone", async () => {
  const { fake, id } = await awake();
  await fake.destroy(id);
  await fake.destroy(id);
  expect(await fake.get(id)).toEqual({
    id,
    state: "gone",
    labels: {},
    autoStopAt: null,
    reason: null,
  });
  expect(await fake.list()).toEqual([]);
  expect(await code(fake.exec(id, "true"))).toBe("not_found");
  expect(await code(fake.ensureAwake(id))).toBe("not_found");
  expect(await code(fake.usage(id))).toBe("not_found");
});

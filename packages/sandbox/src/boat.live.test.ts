/*
 * One pass over the real boat.dev API. It runs only when asked for, with BOAT_LIVE=1 as well as
 * the key: the key alone is not enough, because it also sits in a developer's `.env`, which Bun
 * loads for every `bun test`. It creates one small sandbox for under a minute (about a cent,
 * and one of the account's rationed starts) and deletes it:
 *
 *   BOAT_LIVE=1 BOAT_API_KEY=… bun test packages/sandbox/src/boat.live.test.ts
 */

import { expect, test } from "bun:test";
import { BoatProvider } from "./boat.ts";
import type { ExecEvent, SandboxAddress, SandboxState } from "./provider.ts";

const apiKey = process.env.BOAT_API_KEY;
const live = process.env.BOAT_LIVE === "1" && Boolean(apiKey);
const PORT = 4500;

test.skipIf(!live)(
  "a sandbox on boat.dev: create, exec, files, address, stop, resume, destroy",
  async () => {
    const boat = new BoatProvider({ apiKey: apiKey! });
    const run = `live-${Date.now().toString(36)}`;
    const labels = { "ponzu-live-test": run };
    const options = {
      idempotencyKey: run,
      name: run,
      labels,
      env: { LIVE_VALUE: "from-env" },
      ports: [PORT],
      // Stops by itself in five minutes if this test dies before its cleanup.
      autoStopSeconds: 300,
    };
    const timings: Record<string, number | string> = {};
    const timed = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        timings[what] = Math.round(performance.now() - started);
      }
    };
    const until = async (id: string, state: SandboxState) => {
      // A stop is usually done in a few seconds, but one took 50.
      for (const deadline = Date.now() + 120_000; (await boat.get(id)).state !== state; ) {
        if (Date.now() > deadline) throw new Error(`sandbox never became ${state}`);
        await Bun.sleep(250);
      }
    };
    const answers = async (address: SandboxAddress, path: string, authorized = true) => {
      const response = await fetch(address.url + path, {
        headers: authorized ? address.headers : {},
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, body: await response.text() };
    };

    try {
      const created = await timed("create", () => boat.create(options));
      const id = created.sandbox.id;
      const address = created.addresses[0]!;
      expect(address.port).toBe(PORT);
      expect(address.token).toBeTruthy();
      expect(address.url).not.toContain(address.token!);

      const first = await timed("awake after create", () => boat.ensureAwake(id));
      expect(first.sandbox.state).toBe("awake");
      expect(first.sandbox.labels).toEqual(labels);
      // The create started it, so whatever this call saw, it was not its own resume.
      expect(first.resumed).toBe(false);
      timings["start after create"] = first.start;

      // A retry with the same key and options must not make a second sandbox.
      expect((await boat.create(options)).sandbox.id).toBe(id);
      await expect(boat.create({ ...options, env: { LIVE_VALUE: "other" } })).rejects.toMatchObject(
        { code: "conflict" },
      );

      const echoed = await timed("exec", () => boat.exec(id, 'echo "$LIVE_VALUE"; exit 3'));
      expect(echoed).toMatchObject({ exitCode: 3, stdout: "from-env\n", timedOut: false });
      // An absolute working directory is taken as it is, a relative one from the home folder.
      expect((await boat.exec(id, "pwd", { cwd: "/tmp" })).stdout).toBe("/tmp\n");
      await expect(boat.exec(id, "true", { timeoutSeconds: 601 })).rejects.toMatchObject({
        code: "rejected",
      });

      const events: ExecEvent[] = [];
      for await (const event of boat.execStream(id, "echo out; echo err >&2")) events.push(event);
      expect(events).toContainEqual({ type: "stdout", data: "out\n" });
      expect(events).toContainEqual({ type: "stderr", data: "err\n" });
      expect(events.at(-1)).toEqual({ type: "exit", exitCode: 0, timedOut: false });

      const bytes = new Uint8Array([0, 255, 104, 105, 10]);
      await timed("writeFile", () => boat.writeFile(id, "live/data.bin", bytes));
      await boat.writeFile(id, "live/hello.txt", "hello from ponzu\n");
      expect(await timed("readFile", () => boat.readFile(id, "live/data.bin"))).toEqual(bytes);
      await expect(boat.readFile(id, "live/none.txt")).rejects.toMatchObject({ code: "not_found" });
      expect((await boat.exec(id, "pwd", { cwd: "live" })).stdout).toBe("/home/user/live\n");

      const server = await boat.spawn(id, `python3 -m http.server ${PORT}`, { cwd: "live" });
      await timed("address answers", async () => {
        while ((await answers(address, "/hello.txt")).status !== 200) await Bun.sleep(250);
      });
      expect(await answers(address, "/hello.txt")).toEqual({
        status: 200,
        body: "hello from ponzu\n",
      });
      expect((await answers(address, "/hello.txt", false)).status).toBe(403);
      expect(await boat.address(id, PORT)).toEqual(address);
      expect((await boat.process(id, server.pid)).state).toBe("running");

      const extended = await boat.extend(id, 600);
      expect(extended.autoStopAt).toBeGreaterThan(first.sandbox.autoStopAt!);
      // Awake already, so a new environment cannot be applied, and the wake must say so.
      await expect(boat.ensureAwake(id, { env: { LIVE_VALUE: "new" } })).rejects.toMatchObject({
        code: "conflict",
      });

      await timed("stop to asleep", async () => {
        await boat.stop(id);
        await until(id, "asleep");
      });
      await expect(boat.exec(id, "true")).rejects.toMatchObject({ code: "not_running" });

      const woken = await timed("awake after resume", () => boat.ensureAwake(id));
      // Explicitly stopped seconds ago, so the machine was only frozen: the server is still up.
      expect(woken).toMatchObject({ start: "warm", resumed: true });
      expect((await boat.exec(id, "cat live/hello.txt")).stdout).toBe("hello from ponzu\n");
      expect(await answers(address, "/hello.txt")).toEqual({
        status: 200,
        body: "hello from ponzu\n",
      });

      const usage = await boat.usage(id);
      expect(usage.awakeSeconds).toBeGreaterThan(0);
      expect(usage.costUsd).toBeLessThan(0.05);
      timings["awake seconds billed"] = usage.awakeSeconds;

      await timed("destroy", () => boat.destroy(id));
      expect((await boat.get(id)).state).toBe("gone");
      await timed("destroy again", () => boat.destroy(id));
    } finally {
      // By label, not by the id that came back: a create whose answer was lost still made one.
      for (const left of await boat.list({ labels })) await boat.destroy(left.id);
      console.log("boat.dev live timings (ms):", JSON.stringify(timings));
    }
    expect(await boat.list({ labels })).toEqual([]);
  },
  300_000,
);

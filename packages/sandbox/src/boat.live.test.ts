/*
 * One pass over the real boat.dev API. Skipped unless BOAT_API_KEY is set, so it never runs in
 * CI. It creates one small sandbox for under a minute (about a cent) and deletes it:
 *
 *   BOAT_API_KEY=… bun test packages/sandbox/src/boat.live.test.ts
 */

import { expect, test } from "bun:test";
import { BoatProvider } from "./boat.ts";
import type { ExecEvent, SandboxAddress, SandboxState } from "./provider.ts";

const apiKey = process.env.BOAT_API_KEY;
const PORT = 4500;

test.skipIf(!apiKey)(
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

    let id: string | undefined;
    try {
      const created = await timed("create", () => boat.create(options));
      id = created.sandbox.id;
      const address = created.addresses[0]!;
      expect(address.port).toBe(PORT);
      expect(address.token).toBeTruthy();
      expect(address.url).not.toContain(address.token!);

      const first = await timed("awake after create", () => boat.ensureAwake(id!));
      expect(first.sandbox.state).toBe("awake");
      expect(first.sandbox.labels).toEqual(labels);
      timings["start after create"] = first.start;

      // A retry with the same key and options must not make a second sandbox.
      expect((await boat.create(options)).sandbox.id).toBe(id);

      const echoed = await timed("exec", () => boat.exec(id!, 'echo "$LIVE_VALUE"; exit 3'));
      expect(echoed).toMatchObject({ exitCode: 3, stdout: "from-env\n", timedOut: false });

      const events: ExecEvent[] = [];
      for await (const event of boat.execStream(id, "echo out; echo err >&2")) events.push(event);
      expect(events).toContainEqual({ type: "stdout", data: "out\n" });
      expect(events).toContainEqual({ type: "stderr", data: "err\n" });
      expect(events.at(-1)).toEqual({ type: "exit", exitCode: 0, timedOut: false });

      const bytes = new Uint8Array([0, 255, 104, 105, 10]);
      await timed("writeFile", () => boat.writeFile(id!, "live/data.bin", bytes));
      await boat.writeFile(id, "live/hello.txt", "hello from ponzu\n");
      expect(await timed("readFile", () => boat.readFile(id!, "live/data.bin"))).toEqual(bytes);
      await expect(boat.readFile(id, "live/none.txt")).rejects.toMatchObject({ code: "not_found" });

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

      await timed("stop to asleep", async () => {
        await boat.stop(id!);
        await until(id!, "asleep");
      });
      await expect(boat.exec(id, "true")).rejects.toMatchObject({ code: "not_running" });

      const woken = await timed("awake after resume", () => boat.ensureAwake(id!));
      // Explicitly stopped seconds ago, so the machine was only frozen: the server is still up.
      expect(woken.start).toBe("warm");
      expect((await boat.exec(id, "cat live/hello.txt")).stdout).toBe("hello from ponzu\n");
      expect(await answers(address, "/hello.txt")).toEqual({
        status: 200,
        body: "hello from ponzu\n",
      });

      const usage = await boat.usage(id);
      expect(usage.awakeSeconds).toBeGreaterThan(0);
      expect(usage.costUsd).toBeLessThan(0.05);
      timings["awake seconds billed"] = usage.awakeSeconds;
    } finally {
      if (id) {
        await timed("destroy", () => boat.destroy(id!));
        expect((await boat.get(id)).state).toBe("gone");
      }
      console.log("boat.dev live timings (ms):", JSON.stringify(timings));
    }
    expect(await boat.list({ labels })).toEqual([]);
  },
  300_000,
);

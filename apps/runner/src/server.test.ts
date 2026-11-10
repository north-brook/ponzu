import { expect, test } from "bun:test";
import { serve } from "./server.ts";

test("a poke starts a claim and carries nothing; health says the runner is up", async () => {
  let pokes = 0;
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    poke: () => pokes++,
    health: () => ({ ok: true, state: "idle" }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const poked = await fetch(`${base}/poke`, { method: "POST", body: "ignored" });
    expect(poked.status).toBe(204);
    expect(pokes).toBe(1);
    expect((await fetch(`${base}/poke`)).status).toBe(405);
    expect(pokes).toBe(1);

    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ok: true, state: "idle" });
    expect((await fetch(`${base}/anything`, { method: "POST" })).status).toBe(404);
  } finally {
    server.stop();
  }
});

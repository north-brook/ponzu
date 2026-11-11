import { expect, test } from "bun:test";
import { serve } from "./server.ts";

test("a poke starts a claim and carries nothing; health says the runner is up", async () => {
  let pokes = 0;
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    portToken: "port-secret",
    poke: () => pokes++,
    health: () => ({ ok: true, state: "idle" }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const fetch = (url: string, init: RequestInit = {}) =>
    globalThis.fetch(url, { ...init, headers: { authorization: "Bearer port-secret" } });
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

test("the public address answers nothing without the port token", async () => {
  let pokes = 0;
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    portToken: "port-secret",
    poke: () => pokes++,
    health: () => ({ ok: true, state: "idle" }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const wrong = { authorization: "Bearer port-secreT" };
    expect((await fetch(`${base}/poke`, { method: "POST", headers: wrong })).status).toBe(401);
    expect(pokes).toBe(0);
  } finally {
    server.stop();
  }
});

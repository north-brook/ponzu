import { expect, test } from "bun:test";
import { serve } from "./server.ts";

function served() {
  let pokes = 0;
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    portToken: "port-secret",
    poke: () => pokes++,
    health: () => ({ started: true, state: "idle" }),
  });
  return { server, base: `http://127.0.0.1:${server.port}`, pokes: () => pokes };
}

const BEARER = { authorization: "Bearer port-secret" };

test("a poke starts a claim and carries nothing; health says the runner is up", async () => {
  const { server, base, pokes } = served();
  const fetch = (url: string, init: RequestInit = {}) =>
    globalThis.fetch(url, { ...init, headers: BEARER });
  try {
    const poked = await fetch(`${base}/poke`, { method: "POST", body: "ignored" });
    expect(poked.status).toBe(204);
    expect(pokes()).toBe(1);
    expect((await fetch(`${base}/poke`)).status).toBe(405);
    expect(pokes()).toBe(1);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ started: true, state: "idle" });
    expect((await fetch(`${base}/anything`, { method: "POST" })).status).toBe(404);
  } finally {
    server.stop();
  }
});

test("the public address answers nothing without the port token", async () => {
  const { server, base, pokes } = served();
  try {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/health`, { headers: { authorization: "port-secret" } })).status,
    ).toBe(401);
    const wrong = { authorization: "Bearer port-secreT" };
    expect((await fetch(`${base}/poke`, { method: "POST", headers: wrong })).status).toBe(401);
    expect((await fetch(`${base}/poke`, { method: "POST" })).status).toBe(401);
    expect(pokes()).toBe(0);
    // Unknown routes, and the old report route, say nothing either.
    expect((await fetch(`${base}/report`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: BEARER })).status).toBe(200);
  } finally {
    server.stop();
  }
});

test("the report route is gone", async () => {
  const { server, base } = served();
  try {
    const report = await fetch(`${base}/report`, { method: "POST", headers: BEARER });
    expect(report.status).toBe(404);
  } finally {
    server.stop();
  }
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { FakeClock } from "@ponzu/sandbox";
import type { Actor } from "../auth/actor.ts";
import {
  type CheckRateLimit,
  createVercelRateLimit,
  RATE_LIMIT_TIMEOUT_MS,
} from "../deps/rate-limit.ts";
import { call, canvasWithRunner, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { createLogger } from "./log.ts";
import { RATE_LIMIT_IDS, RATE_LIMITS, RETRY_AFTER_SECONDS, rateLimitFor } from "./rate-limits.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { ada: "admin", maya: "write" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const create = (login: string, name: string) =>
  t.app.request("/v1/canvases", {
    method: "POST",
    headers: { ...as(login), "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: ws.id, repoId: ws.repo.id, name }),
  });

describe("canvas creates", () => {
  test("the 31st in an hour is a 429 rate_limited with Retry-After, and the next hour opens again", async () => {
    t.rateLimit.limit("canvas-creates", 30);
    for (let i = 1; i <= 30; i++) expect((await create("maya", `Canvas ${i}`)).status).toBe(201);

    const limited = await create("maya", "Canvas 31");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests. Try again in a moment." },
    });
    // Counted per person: someone else in the same workspace is not held back.
    expect((await create("ada", "Ada's")).status).toBe(201);

    const checks = t.rateLimit.checks.filter((check) => check.id === "canvas-creates");
    expect(checks.at(-2)).toEqual({
      id: "canvas-creates",
      key: ws.people.maya!.userId,
      answer: "limited",
    });

    t.clock.advance(RATE_LIMITS["canvas-creates"].windowSeconds * 1000);
    // An hour on, the access tokens have run out too: sign in again, as the app would refresh.
    for (const login of ["ada", "maya"]) ws.people[login] = await t.signInAs({ login });
    expect((await create("maya", "Canvas 32")).status).toBe(201);
  });
});

describe("which limit a request counts against", () => {
  test("each route the table names counts against its own id, and everything else falls to the catch-alls", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", emptyDoc("Counted"));
    const before = t.rateLimit.checks.length;
    // A read by a person is never counted.
    await call(t, as("maya"), "GET", `/v1/canvases/${canvas.id}`);
    await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, { text: "hello" });
    await call(t, as("maya"), "PATCH", `/v1/canvases/${canvas.id}`, { name: "Renamed" });
    await call(t, as("maya"), "POST", "/v1/github/sync");
    await call(t, as("maya"), "POST", "/v1/live", { queries: [] });
    await call(t, runner.headers, "POST", "/v1/runner/git-credential", {});
    await call(t, runner.headers, "POST", "/v1/runner/events/ack", {});

    const user = ws.people.maya!.userId;
    expect(t.rateLimit.checks.slice(before).map(({ id, key }) => [id, key])).toEqual([
      ["messages", user],
      ["user-writes", user],
      ["github-sync", user],
      ["live", user],
      ["runner-git", canvas.id],
      ["runner", canvas.id],
    ]);
  });

  test("a limited runner is refused the same way, by its canvas", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "ada", emptyDoc("Busy runner"));
    t.rateLimit.limit("runner", 0);
    try {
      const refused = await t.app.request("/v1/runner/events/ack", {
        method: "POST",
        headers: { ...runner.headers, "content-type": "application/json" },
        body: "{}",
      });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect(t.rateLimit.checks.at(-1)).toEqual({
        id: "runner",
        key: canvas.id,
        answer: "limited",
      });
    } finally {
      t.rateLimit.limit("runner", Number.POSITIVE_INFINITY);
    }
  });

  test("the table's routes are all routes the API has", () => {
    const declared = new Set(t.app.routes.map((route) => `${route.method} ${route.path}`));
    const named = RATE_LIMIT_IDS.flatMap((id) => RATE_LIMITS[id].routes);
    expect(named.filter((route) => !declared.has(route))).toEqual([]);
    // No route is named twice.
    expect(new Set(named).size).toBe(named.length);
  });

  test("a person's route never counts against a runner's id, nor the reverse", () => {
    const person = { kind: "user", user: { id: "usr_1" }, sessionId: "s" } as Actor;
    const runner = { kind: "runner", tokenId: "t", canvasId: "cnv_1", runnerId: "r" } as Actor;
    expect(rateLimitFor("POST /v1/runner/git-credential", person)).toEqual({
      id: "user-writes",
      key: "usr_1",
    });
    expect(rateLimitFor("POST /v1/canvases/:id/messages", runner)).toEqual({
      id: "runner",
      key: "cnv_1",
    });
    expect(rateLimitFor("GET /v1/canvases/:id", runner)).toEqual({ id: "runner", key: "cnv_1" });
    expect(rateLimitFor("PUT /v1/canvases/:id/presence", person)).toBeNull();
    expect(rateLimitFor("DELETE /v1/canvases/:id", person)).toEqual({
      id: "user-writes",
      key: "usr_1",
    });
  });
});

describe("failing open through the app", () => {
  test("a firewall that never answers holds a request 500 ms and then lets it through", async () => {
    const clock = new FakeClock();
    let asked = 0;
    const never: CheckRateLimit = () => {
      asked++;
      return new Promise(() => {});
    };
    const lines: { event: string }[] = [];
    const app = await createTestApp({
      shared: { sandboxes: t.sandboxes, clock },
      rateLimit: createVercelRateLimit({
        clock,
        log: createLogger((line) => lines.push(line)),
        check: never,
      }),
    });
    try {
      const own = await workspaceWithRepo(app, { ines: "admin" });
      const pending = app.app.request("/v1/canvases", {
        method: "POST",
        headers: { ...own.people.ines!.headers, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: own.id, repoId: own.repo.id, name: "Through" }),
      });
      const deadline = Date.now() + 5_000;
      while (asked === 0 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
      expect(asked).toBe(1);
      clock.advance(RATE_LIMIT_TIMEOUT_MS);
      expect((await pending).status).toBe(201);
      expect(lines.map((line) => line.event)).toContain("rate_limit_unavailable");
    } finally {
      await app.close();
    }
  });
});

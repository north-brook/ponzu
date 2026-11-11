import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { admitSession, createDb } from "@ponzu/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { createApp } from "../create-app.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";
import { parseMinimumVersions } from "./client-version.ts";
import type { AppEnv } from "./context.ts";
import { isAllowedOrigin } from "./cors.ts";
import { ApiError, UpstreamError } from "./errors.ts";
import { validate } from "./validate.ts";

let t: TestApp;
let person: SignedInPerson;
beforeAll(async () => {
  t = await createTestApp();
  person = await t.signInAs();
});
afterAll(() => t.close());

/** The app with routes that fail in each way a route can. */
function failing() {
  const boom = new Hono<AppEnv>()
    .get("/crash", access.public, () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2");
    })
    .get("/upstream", access.public, () => {
      throw new UpstreamError("github", "GET /user answered 500", {
        status: 500,
        cause: new Error('{"message":"internal github detail"}'),
      });
    })
    .get("/refused", access.public, () => {
      throw new ApiError(403, "forbidden", "You cannot open this design.", {
        details: { designId: "des_1" },
        cause: new Error("membership row missing for usr_secretinternal"),
      });
    })
    .get("/shape", access.public, (c) => c.json(z.object({ id: z.string() }).parse({ id: 5 })))
    .post(
      "/echo",
      access.public,
      validate("json", z.object({ name: z.string().min(1), size: z.number().int() })),
      (c) => c.json(c.req.valid("json")),
    )
    // What Hono's own middleware throws: a body limit, and what a rate limiter would.
    .post("/small", access.public, bodyLimit({ maxSize: 16 }), (c) => c.json({ ok: true }))
    .get("/busy", access.public, () => {
      throw new HTTPException(429, { message: "limiter internals: bucket usr_9 empty" });
    })
    .get("/teapot", access.public, () => {
      throw new HTTPException(418);
    })
    .get("/broken", access.public, () => {
      throw new HTTPException(502, { message: "proxy internals" });
    })
    .get("/logs-bigint", access.public, (c) => {
      c.var.log.info("committed", { seq: 12n });
      return c.json({ ok: true });
    });
  return createApp(t.deps).route("/v1/test", boom);
}

describe("the error body", () => {
  test("is { error: { code, message } } and JSON, whatever failed", async () => {
    const response = await t.app.request("/v1/me");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Sign in to do this." },
    });
  });

  test("an unexpected failure is internal, with nothing of the failure in it", async () => {
    const response = await failing().request("/v1/test/crash");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal", message: "Something went wrong on our side." },
    });
    for (const internal of ["ECONNREFUSED", "10.1.2.3", "hunter2", "at ", ".ts"]) {
      expect(text).not.toContain(internal);
    }
  });

  test("an upstream failure names the service and not what it said", async () => {
    const response = await failing().request("/v1/test/upstream");
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("upstream_unavailable");
    expect(text).toContain("GitHub");
    expect(text).not.toContain("internal github detail");
    expect(text).not.toContain("answered 500");
  });

  test("a refusal carries its details and never its cause", async () => {
    const response = await failing().request("/v1/test/refused");
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "forbidden",
        message: "You cannot open this design.",
        details: { designId: "des_1" },
      },
    });
    expect(text).not.toContain("usr_secretinternal");
  });

  test("a response that does not fit its schema is internal, not sent", async () => {
    const response = await failing().request("/v1/test/shape");
    expect(response.status).toBe(500);
    expect(((await response.json()) as any).error.code).toBe("internal");
  });

  test("the failure itself is logged, with the request's id", async () => {
    const response = await failing().request("/v1/test/crash");
    const requestId = response.headers.get("x-request-id");
    const line = t.logs.findLast((entry) => entry.event === "request_failed")!;
    expect(line).toMatchObject({ level: "error", requestId, status: 500, errorCode: "internal" });
    expect((line.error as { message: string }).message).toContain("ECONNREFUSED");
  });

  test("a refusal by Hono's own middleware keeps its status and gets a code of ours", async () => {
    const tooLarge = await failing().request("/v1/test/small", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(64) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: { code: "payload_too_large", message: "The request is too large." },
    });

    const limited = await failing().request("/v1/test/busy");
    expect(limited.status).toBe(429);
    const text = await limited.text();
    expect(JSON.parse(text).error.code).toBe("rate_limited");
    expect(text).not.toContain("bucket");

    // A status with no code of its own is still the caller's fault, in the one error body.
    const other = await failing().request("/v1/test/teapot");
    expect([other.status, ((await other.json()) as any).error.code]).toEqual([
      418,
      "invalid_request",
    ]);
  });

  test("anything else Hono throws is internal", async () => {
    const response = await failing().request("/v1/test/broken");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("internal");
    expect(text).not.toContain("proxy");
  });

  test("a database that does not answer in time is database_unavailable, not internal", async () => {
    // The driver the deployment uses, with a deadline that has already passed: the request
    // fails before anything is sent.
    const db = createDb("postgres://user:password@database.invalid/ponzu", {
      deadline: () => AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    });
    const app = createApp({ ...t.deps, db });

    const response = await app.request("/v1/me", { headers: person.headers });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "database_unavailable",
        message: "Ponzu could not reach its database. Try again in a moment.",
      },
    });
    // Health reports the same thing in its own words.
    const health = await app.request("/v1/health");
    expect([health.status, ((await health.json()) as any).database]).toEqual([503, false]);
  });

  test("a statement Postgres refuses is still internal", async () => {
    const refusing = new Hono<AppEnv>().get(
      "/v1/test/refused-statement",
      access.public,
      async (c) =>
        c.json(await admitSession(c.var.deps.db, { id: "session_x", userId: "usr_nobody" })),
    );
    const response = await createApp(t.deps)
      .route("/", refusing)
      .request("/v1/test/refused-statement");
    expect([response.status, ((await response.json()) as any).error.code]).toEqual([
      500,
      "internal",
    ]);
  });
});

describe("the dependencies a route is given", () => {
  test("the database has no transactions, as in a deployment", async () => {
    const transacting = new Hono<AppEnv>().post("/v1/test/transaction", access.public, async (c) =>
      c.json(await c.var.deps.db.transaction(async () => "committed")),
    );

    const response = await createApp(t.deps)
      .route("/", transacting)
      .request("/v1/test/transaction", { method: "POST" });

    expect(response.status).toBe(500);
    const line = t.logs.findLast((entry) => entry.event === "request_failed")!;
    expect((line.error as { message: string }).message).toContain("No transactions support");
  });

  test("work left running after the answer is waited for, and its failure is logged", async () => {
    const done: string[] = [];
    const working = new Hono<AppEnv>().post("/v1/test/background", access.public, (c) => {
      c.var.deps.background(
        "wake",
        Bun.sleep(5).then(() => done.push("woke")),
      );
      c.var.deps.background(
        "sync",
        Promise.reject(new Error("GitHub said ghu_0123456789abcdef0123")),
      );
      return c.body(null, 202);
    });

    const response = await createApp(t.deps)
      .route("/", working)
      .request("/v1/test/background", { method: "POST" });
    expect(response.status).toBe(202);
    expect(done).toEqual([]);

    await t.backgroundDone();

    expect(done).toEqual(["woke"]);
    const line = t.logs.findLast((entry) => entry.event === "background_failed")!;
    expect(line).toMatchObject({ level: "error", name: "sync" });
    expect(JSON.stringify(line)).not.toContain("ghu_");
  });

  test("a log field JSON cannot write does not fail the request", async () => {
    const response = await failing().request("/v1/test/logs-bigint");
    expect(response.status).toBe(200);
    expect(t.logs.findLast((entry) => entry.event === "committed")).toMatchObject({ seq: "12" });
  });
});

describe("validation", () => {
  const post = (body: string, contentType = "application/json") =>
    failing().request("/v1/test/echo", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });

  test("a body that fits reaches the handler parsed", async () => {
    const response = await post(JSON.stringify({ name: "Lisbon", size: 3, extra: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Lisbon", size: 3 });
  });

  test("a body that does not fit says where, and does not repeat what was sent", async () => {
    const response = await post(
      JSON.stringify({ name: "", size: "ghu_notarealtokenbutlookslikeone" }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    const { error } = JSON.parse(text);
    expect(error.code).toBe("invalid_request");
    expect(error.details.issues.map((issue: { path: string }) => issue.path).sort()).toEqual([
      "json.name",
      "json.size",
    ]);
    expect(text).not.toContain("ghu_");
  });

  test("a body that is not JSON at all is invalid_request", async () => {
    for (const response of [await post("{not json"), await post("name=Lisbon", "text/plain")]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.code).toBe("invalid_request");
    }
  });
});

describe("addresses and methods", () => {
  test("nothing there is a 404 in the error model", async () => {
    for (const path of ["/", "/v1", "/v1/nope", "/v1/me/nope", "/v2/health"]) {
      const response = await t.app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "There is nothing at this address." },
      });
    }
  });

  test("the wrong method on a real address is a 405 that names the right ones", async () => {
    const response = await t.app.request("/v1/me", { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, DELETE");
    expect(((await response.json()) as any).error.code).toBe("method_not_allowed");

    const exchange = await t.app.request("/v1/auth/exchange");
    expect(exchange.status).toBe(405);
    expect(exchange.headers.get("allow")).toBe("POST");
  });

  test("HEAD is answered as GET without a body", async () => {
    const response = await t.app.request("/v1/health", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

test("no answer may be kept by a cache, the one that carries tokens least of all", async () => {
  const started = await t.startSignIn({ login: "cached" });
  const exchange = await t.app.request("/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: started.code, code_verifier: started.codeVerifier }),
  });
  expect(exchange.status).toBe(200);
  const answers = [
    exchange,
    await t.app.request("/v1/me", { headers: person.headers }),
    await t.app.request("/v1/me"),
    await t.app.request("/v1/health"),
    await t.app.request("/v1/nope"),
  ];
  for (const response of answers) expect(response.headers.get("cache-control")).toBe("no-store");
});

describe("request ids", () => {
  test("every answer has one, errors and 404s included, and no two are the same", async () => {
    const ids = await Promise.all(
      ["/v1/health", "/v1/me", "/v1/nope"].map(async (path) =>
        (await t.app.request(path)).headers.get("x-request-id"),
      ),
    );
    for (const id of ids) expect(id).toMatch(/^req_/);
    expect(new Set(ids).size).toBe(3);
  });

  test("a sensible id from the caller is kept; anything else is replaced", async () => {
    const kept = await t.app.request("/v1/health", {
      headers: { "x-request-id": "desktop-7f3a9c21" },
    });
    expect(kept.headers.get("x-request-id")).toBe("desktop-7f3a9c21");

    for (const given of ["short", "x".repeat(65), 'has "quotes" and spaces']) {
      const replaced = await t.app.request("/v1/health", { headers: { "x-request-id": given } });
      expect(replaced.headers.get("x-request-id")).toMatch(/^req_test_\d+$/);
    }
  });

  test("the request line in the log carries it, with who asked and how it ended", async () => {
    const response = await t.app.request("/v1/me?code=should-not-be-logged", {
      headers: { ...person.headers, "x-ponzu-client": "macos/2.0.0" },
    });
    const line = t.logs.findLast((entry) => entry.event === "request")!;
    expect(line).toMatchObject({
      level: "info",
      requestId: response.headers.get("x-request-id"),
      method: "GET",
      path: "/v1/me",
      status: 200,
      userId: person.userId,
      client: "macos/2.0.0",
    });
    expect(JSON.stringify(line)).not.toContain("should-not-be-logged");
  });
});

describe("CORS", () => {
  test("the desktop studio, ponzu.design and a local dev server may read answers", () => {
    for (const origin of [
      "ponzu-studio://app",
      "https://ponzu.design",
      "https://app.ponzu.design",
      "https://preview-12.app.ponzu.design",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://localhost",
    ]) {
      expect([origin, isAllowedOrigin(origin)]).toEqual([origin, true]);
    }
  });

  test("nobody else may, lookalikes and user content included", () => {
    for (const origin of [
      "https://ponzu.cloud",
      "https://assets.ponzu.cloud",
      "https://evilponzu.design",
      "https://ponzu.design.evil.example",
      "http://ponzu.design",
      "http://app.ponzu.design",
      "https://localhost:5173",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "https://ponzu.design/path",
      "https://user:pass@ponzu.design",
      "ponzu-studio://other",
      "file://",
      "null",
      "",
    ]) {
      expect([origin, isAllowedOrigin(origin)]).toEqual([origin, false]);
    }
  });

  test("a preflight from an allowed origin is answered without reaching auth", async () => {
    const response = await t.app.request("/v1/me", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,x-ponzu-client",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-ponzu-client");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("an allowed origin can read an error as well as an answer", async () => {
    const refused = await t.app.request("/v1/me", {
      headers: { origin: "https://app.ponzu.design" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("https://app.ponzu.design");
    expect(refused.headers.get("access-control-expose-headers")).toContain("x-request-id");
    expect(refused.headers.get("vary")).toContain("Origin");
  });

  test("another origin gets no permission, and a request with no origin is untouched", async () => {
    const other = await t.app.request("/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const native = await t.app.request("/v1/health");
    expect(native.status).toBe(200);
    expect(native.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the minimum client version", () => {
  let gated: TestApp;
  beforeAll(async () => {
    gated = await createTestApp({
      minimumClientVersions: parseMinimumVersions("macos=2.1.0,ios=1.3.0"),
    });
  });
  afterAll(() => gated.close());

  const ask = async (app: TestApp, client?: string, path = "/v1/health") => {
    const response = await app.app.request(path, {
      headers: client ? { "x-ponzu-client": client } : {},
    });
    return [response.status, response.status === 200 ? undefined : await response.json()];
  };

  test("is off unless configured", async () => {
    expect((await ask(t, "macos/0.0.1"))[0]).toBe(200);
  });

  test("a client older than its platform's minimum gets 426 and what to update to", async () => {
    expect(await ask(gated, "macos/2.0.9")).toEqual([
      426,
      {
        error: {
          code: "client_too_old",
          message: "This version of Ponzu is too old. Update it.",
          details: { platform: "macos", minimumVersion: "2.1.0" },
        },
      },
    ]);
    expect((await ask(gated, "ios/1.2.99"))[0]).toBe(426);
    expect((await ask(gated, "macos/1.80.1"))[0]).toBe(426);
  });

  test("it is refused before sign-in too, so the app can say so on its first screen", async () => {
    expect((await ask(gated, "macos/2.0.0", "/v1/me"))[0]).toBe(426);
  });

  test("the minimum itself, anything newer, and a pre-release of it pass", async () => {
    for (const client of [
      "macos/2.1.0",
      "macos/2.1.1",
      "macos/2.10.0",
      "macos/3.0.0",
      "ios/1.3.0",
      "macos/2.1.0-beta.2",
    ]) {
      expect([client, (await ask(gated, client))[0]]).toEqual([client, 200]);
    }
  });

  test("a platform with no minimum, and a caller that does not say, pass", async () => {
    expect((await ask(gated, "windows/0.1.0"))[0]).toBe(200);
    expect((await ask(gated))[0]).toBe(200);
  });

  test("a platform named after something every object has is one with no minimum", async () => {
    for (const app of [gated, t]) {
      expect((await ask(app, "constructor/1.0.0"))[0]).toBe(200);
    }
  });

  test("a header that is not <platform>/<version> is invalid_request", async () => {
    for (const client of [
      "macos",
      "macos/two",
      "macos/2.1",
      "MacOS/2.1.0",
      "macos/2.1.0/extra",
      "/2.1.0",
    ]) {
      const [status, body] = await ask(gated, client);
      expect([client, status, (body as any)?.error.code]).toEqual([client, 400, "invalid_request"]);
    }
  });

  test("a setting with a typo is refused outright, not read as no gate", () => {
    for (const text of ["macos", "macos=2", "macos=2.1.0;ios=1.0.0", "mac os=2.1.0", "=2.1.0"]) {
      expect(() => parseMinimumVersions(text)).toThrow();
    }
    expect(parseMinimumVersions("")).toEqual({});
    expect(parseMinimumVersions(" macos=2.1.0 , ios=1.3.0 ")).toEqual({
      macos: "2.1.0",
      ios: "1.3.0",
    });
  });
});

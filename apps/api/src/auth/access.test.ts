import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  createCanvas,
  createRunnerToken,
  revokeRunnerTokens,
  takeRunnerLease,
  upsertMembership,
  upsertWorkspace,
} from "@ponzu/db";
import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { createApp } from "../create-app.ts";
import type { AppEnv } from "../http/context.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";
import { access, firstUndeclared } from "./access.ts";
import { requireWorkspace } from "./authorize.ts";

let t: TestApp;
let person: SignedInPerson;
beforeAll(async () => {
  t = await createTestApp();
  person = await t.signInAs({ login: "bryce" });
});
afterAll(() => t.close());

/** GET /v1/me with this as the Authorization header (or none), as `[status, error code]`. */
async function me(authorization?: string) {
  const response = await t.app.request("/v1/me", {
    headers: authorization === undefined ? {} : { authorization },
  });
  const body = (await response.json()) as { error?: { code: string } };
  return [response.status, body.error?.code];
}

const session = () => ({ userId: person.workos.id, sessionId: "session_test" });

describe("a route for a signed-in person", () => {
  test("takes a WorkOS access token and knows who it is", async () => {
    const response = await t.app.request("/v1/me", { headers: person.headers });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).user.id).toBe(person.userId);
  });

  test("no token, or something that is not a bearer token: unauthenticated", async () => {
    expect(await me()).toEqual([401, "unauthenticated"]);
    expect(await me("")).toEqual([401, "unauthenticated"]);
    expect(await me("Bearer")).toEqual([401, "unauthenticated"]);
    expect(await me(`Basic ${btoa("bryce:hunter2")}`)).toEqual([401, "unauthenticated"]);
    expect(await me(`Bearer ${person.accessToken} extra`)).toEqual([401, "unauthenticated"]);
  });

  test("a malformed token: token_invalid", async () => {
    expect(await me("Bearer not-a-jwt")).toEqual([401, "token_invalid"]);
    expect(await me("Bearer a.b.c")).toEqual([401, "token_invalid"]);
    // A real token with its payload swapped for another's.
    const [header, , signature] = person.accessToken.split(".");
    const payload = btoa(
      JSON.stringify({ sub: "user_someone_else", sid: "s", client_id: "client_test" }),
    );
    expect(await me(`Bearer ${header}.${payload}.${signature}`)).toEqual([401, "token_invalid"]);
  });

  test("an expired token: token_expired", async () => {
    const expired = await t.workos.signAccessToken(session(), { expiresIn: -60 });
    expect(await me(`Bearer ${expired}`)).toEqual([401, "token_expired"]);
  });

  test("a token from a clock a little ahead of ours is taken; one from the future is not", async () => {
    const sid = JSON.parse(atob(person.accessToken.split(".")[1]!)).sid;
    const issued = (seconds: number) =>
      t.workos.signAccessToken({ userId: person.workos.id, sessionId: sid }, { issuedIn: seconds });

    expect((await me(`Bearer ${await issued(5)}`))[0]).toBe(200);
    expect(await me(`Bearer ${await issued(300)}`)).toEqual([401, "token_invalid"]);
  });

  test("a token that never says when it runs out: token_invalid", async () => {
    const sid = JSON.parse(atob(person.accessToken.split(".")[1]!)).sid;
    const endless = await t.workos.signAccessToken(
      { userId: person.workos.id, sessionId: sid },
      { expiresIn: null },
    );
    expect(await me(`Bearer ${endless}`)).toEqual([401, "token_invalid"]);
  });

  test("a token is good for fifteen minutes at most, whatever expiry it carries", async () => {
    const other = await createTestApp();
    const fresh = await other.signInAs();
    const sid = JSON.parse(atob(fresh.accessToken.split(".")[1]!)).sid;
    const tenYears = await other.workos.signAccessToken(
      { userId: fresh.workos.id, sessionId: sid },
      { expiresIn: 10 * 365 * 86_400 },
    );
    const ask = async () => {
      const response = await other.app.request("/v1/me", {
        headers: { authorization: `Bearer ${tenYears}` },
      });
      return response.status === 200 ? 200 : ((await response.json()) as any).error.code;
    };

    other.clock.advance(14 * 60_000);
    expect(await ask()).toBe(200);
    other.clock.advance(2 * 60_000);
    expect(await ask()).toBe("token_expired");
    await other.close();
  });

  test("a token runs out five minutes after it was issued, by the API's own clock", async () => {
    const other = await createTestApp();
    const fresh = await other.signInAs();
    const ask = async () => (await other.app.request("/v1/me", { headers: fresh.headers })).status;

    other.clock.advance(299_000);
    expect(await ask()).toBe(200);
    // Half a minute is allowed for the two clocks disagreeing, and no more.
    other.clock.advance(32_000);
    expect(await ask()).toBe(401);
    await other.close();
  });

  test("another issuer: token_invalid", async () => {
    const forged = await t.workos.signAccessToken(session(), {
      issuer: "https://api.workos.com/user_management/client_someone_else",
    });
    expect(await me(`Bearer ${forged}`)).toEqual([401, "token_invalid"]);
  });

  test("another application's client id: token_invalid", async () => {
    const forged = await t.workos.signAccessToken(session(), { clientId: "client_someone_else" });
    expect(await me(`Bearer ${forged}`)).toEqual([401, "token_invalid"]);
  });

  test("another algorithm: token_invalid", async () => {
    const hs256 = await t.workos.signAccessToken(session(), { signedWith: "shared-secret" });
    expect(await me(`Bearer ${hs256}`)).toEqual([401, "token_invalid"]);
    // Unsigned, claiming to need no signature.
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const [, payload] = person.accessToken.split(".");
    expect(await me(`Bearer ${encode({ alg: "none" })}.${payload}.`)).toEqual([
      401,
      "token_invalid",
    ]);
  });

  test("signed by a key WorkOS does not publish: token_invalid", async () => {
    const forged = await t.workos.signAccessToken(session(), { signedWith: "other-key" });
    expect(await me(`Bearer ${forged}`)).toEqual([401, "token_invalid"]);
  });

  test("a good token for someone Ponzu has no user for: session_unknown", async () => {
    const stranger = t.workos.addUser({ email: "stranger@example.com" });
    const token = await t.workos.signAccessToken({ userId: stranger.id, sessionId: "session_x" });
    expect(await me(`Bearer ${token}`)).toEqual([401, "session_unknown"]);
  });

  test("a good token for a real person, from a session that did not come through the exchange: session_unknown", async () => {
    // WorkOS is a public client: anyone can finish a sign-in with it directly and hold a
    // perfectly signed token for their WorkOS user. Only the exchange checks GitHub.
    const direct = await t.workos.signAccessToken({
      userId: person.workos.id,
      sessionId: "session_started_at_workos",
    });
    expect(await me(`Bearer ${direct}`)).toEqual([401, "session_unknown"]);
  });

  test("an admitted session presented for a different WorkOS user: session_unknown", async () => {
    const other = await t.signInAs({ login: "ines" });
    const sid = JSON.parse(atob(other.accessToken.split(".")[1]!)).sid;
    const crossed = await t.workos.signAccessToken({ userId: person.workos.id, sessionId: sid });
    expect(await me(`Bearer ${crossed}`)).toEqual([401, "session_unknown"]);
  });

  test("a runner token is not a person", async () => {
    expect(await me("Bearer pzr_0000000000000000000000000000000000000000000000000000")).toEqual([
      401,
      "token_invalid",
    ]);
  });

  test("the signing keys being unreachable is upstream_unavailable, not a verdict on the token", async () => {
    const cold = await createTestApp();
    const fresh = await cold.signInAs();
    // A new instance has not fetched the keys yet.
    const again = createApp({ ...cold.deps, workos: { ...cold.deps.workos, jwks: brokenJwks } });
    const response = await again.request("/v1/me", { headers: fresh.headers });
    expect(response.status).toBe(502);
    expect(((await response.json()) as any).error.code).toBe("upstream_unavailable");
    await cold.close();
  });
});

const brokenJwks = (() => {
  throw new TypeError("fetch failed");
}) as unknown as TestApp["deps"]["workos"]["jwks"];

let accounts = 0;
/** A workspace nobody belongs to yet. */
function workspace() {
  const githubAccountId = 500_000 + accounts++;
  return upsertWorkspace(t.db, {
    githubAccountId,
    githubLogin: `north-brook-${githubAccountId}`,
    kind: "org",
    name: "North Brook",
    avatarUrl: null,
    installationId: githubAccountId,
    repositorySelection: "all",
    installedByUserId: null,
  });
}

async function canvas() {
  return createCanvas(t.db, {
    workspaceId: (await workspace()).id,
    repoId: null,
    ownerId: person.userId,
    claudeAccountId: null,
    name: "Lisbon",
    branch: null,
    doc: emptyDoc("Lisbon"),
  });
}

describe("a route for a runner", () => {
  const withRunnerRoute = () => {
    const routes = new Hono<AppEnv>().get("/v1/test/canvas", access.runner, (c) =>
      c.json({ canvasId: c.var.actor.canvasId, runnerId: c.var.actor.runnerId }),
    );
    return createApp(t.deps).route("/", routes);
  };

  test("takes a runner token with its canvas's lease, and is told the one canvas it is for", async () => {
    const app = withRunnerRoute();
    const { id: canvasId } = await canvas();
    const { token } = await createRunnerToken(t.db, { canvasId, ttlSeconds: 600 });
    const { runnerId } = await takeRunnerLease(t.db, { canvasId, now: new Date() });

    const response = await app.request("/v1/test/canvas", {
      headers: { authorization: `Bearer ${token}`, [RUNNER_HEADER]: runnerId },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canvasId, runnerId });
  });

  test("refuses a runner without the canvas's current lease as superseded", async () => {
    const app = withRunnerRoute();
    const { id: canvasId } = await canvas();
    const { token } = await createRunnerToken(t.db, { canvasId, ttlSeconds: 600 });
    const ask = async (lease?: string) => {
      const response = await app.request("/v1/test/canvas", {
        headers: { authorization: `Bearer ${token}`, ...(lease ? { [RUNNER_HEADER]: lease } : {}) },
      });
      return [response.status, ((await response.json()) as any).error?.code];
    };
    // Before any runner has started, nobody holds it.
    expect(await ask()).toEqual([409, "superseded"]);
    const older = await takeRunnerLease(t.db, { canvasId, now: new Date() });
    const newer = await takeRunnerLease(t.db, { canvasId, now: new Date() });

    expect(await ask(older.runnerId)).toEqual([409, "superseded"]);
    expect(await ask()).toEqual([409, "superseded"]);
    expect(await ask(newer.runnerId)).toEqual([200, undefined]);
    // "taking" is how the one route that takes the lease asks, never a header value.
    expect(await ask("taking")).toEqual([409, "superseded"]);
  });

  test("refuses no token, a made-up one, a revoked one and a person's", async () => {
    const app = withRunnerRoute();
    const { id: canvasId } = await canvas();
    const { token } = await createRunnerToken(t.db, { canvasId, ttlSeconds: 600 });
    await revokeRunnerTokens(t.db, canvasId);
    const ask = async (authorization?: string) => {
      const response = await app.request("/v1/test/canvas", {
        headers: authorization ? { authorization } : {},
      });
      return [response.status, ((await response.json()) as any).error.code];
    };

    expect(await ask()).toEqual([401, "unauthenticated"]);
    expect(await ask(`Bearer pzr_${"0".repeat(52)}`)).toEqual([401, "token_invalid"]);
    expect(await ask(`Bearer ${token}`)).toEqual([401, "token_invalid"]);
    expect(await ask(person.headers.authorization)).toEqual([401, "token_invalid"]);
  });
});

describe("a route for a person or a runner", () => {
  const withSharedRoute = () => {
    const routes = new Hono<AppEnv>().get("/v1/test/either", access.userOrRunner, (c) => {
      const { actor } = c.var;
      return c.json(actor.kind === "user" ? { user: actor.user.id } : { canvas: actor.canvasId });
    });
    return createApp(t.deps).route("/", routes);
  };
  const ask = async (authorization?: string, lease?: string) => {
    const response = await withSharedRoute().request("/v1/test/either", {
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(lease ? { [RUNNER_HEADER]: lease } : {}),
      },
    });
    const body = (await response.json()) as any;
    return response.status === 200 ? body : [response.status, body.error.code];
  };

  test("knows which of the two is asking, and holds a runner to its lease", async () => {
    const { id: canvasId } = await canvas();
    const { token } = await createRunnerToken(t.db, { canvasId, ttlSeconds: 600 });
    const { runnerId } = await takeRunnerLease(t.db, { canvasId, now: new Date() });

    expect(await ask(person.headers.authorization)).toEqual({ user: person.userId });
    expect(await ask(`Bearer ${token}`, runnerId)).toEqual({ canvas: canvasId });
    expect(await ask(`Bearer ${token}`)).toEqual([409, "superseded"]);
    expect(await ask(`Bearer ${token}`, "taking")).toEqual([409, "superseded"]);
  });

  test("refuses anyone who is neither, each as its own kind of token would be", async () => {
    const direct = await t.workos.signAccessToken({
      userId: person.workos.id,
      sessionId: "session_started_at_workos",
    });

    expect(await ask()).toEqual([401, "unauthenticated"]);
    expect(await ask("Bearer not-a-jwt")).toEqual([401, "token_invalid"]);
    expect(await ask(`Bearer pzr_${"0".repeat(52)}`)).toEqual([401, "token_invalid"]);
    expect(await ask(`Bearer ${direct}`)).toEqual([401, "session_unknown"]);
  });
});

describe("what a signed-in person may touch", () => {
  const withWorkspaceRoutes = () => {
    const routes = new Hono<AppEnv>()
      .use(access.user)
      .get("/:id", async (c) => c.json(await requireWorkspace(c, c.req.param("id"))))
      .delete("/:id", async (c) => c.json(await requireWorkspace(c, c.req.param("id"), "admin")));
    return createApp(t.deps).route("/v1/test/workspaces", routes);
  };
  const ask = async (id: string, method = "GET") => {
    const response = await withWorkspaceRoutes().request(`/v1/test/workspaces/${id}`, {
      method,
      headers: person.headers,
    });
    const body = (await response.json()) as any;
    return response.status === 200 ? body : [response.status, body.error.code];
  };

  test("a member gets their workspace, with their role in it", async () => {
    const { id } = await workspace();
    await upsertMembership(t.db, { workspaceId: id, userId: person.userId, role: "member" });

    expect(await ask(id)).toMatchObject({ id, role: "member" });
  });

  test("a workspace they do not belong to and one that does not exist look the same", async () => {
    const { id } = await workspace();

    expect(await ask(id)).toEqual([404, "not_found"]);
    expect(await ask("ws_nowhere")).toEqual([404, "not_found"]);
    // Asking as an admin tells them no more.
    expect(await ask(id, "DELETE")).toEqual([404, "not_found"]);
  });

  test("what only an admin may do is forbidden to a member and open to an admin", async () => {
    const [mine, theirs] = [await workspace(), await workspace()];
    await upsertMembership(t.db, { workspaceId: mine.id, userId: person.userId, role: "admin" });
    await upsertMembership(t.db, { workspaceId: theirs.id, userId: person.userId, role: "member" });

    expect(await ask(mine.id, "DELETE")).toMatchObject({ id: mine.id, role: "admin" });
    expect(await ask(theirs.id, "DELETE")).toEqual([403, "forbidden"]);
  });
});

describe("a route that does not say who may call it", () => {
  const ran: string[] = [];
  /** A handler that records that it ran, which an undeclared one never should. */
  const handler = (name: string) => (c: Context<AppEnv>) => {
    ran.push(name);
    return c.json({ name });
  };
  const passThrough: MiddlewareHandler<AppEnv> = (_c, next) => next();
  /** The answer's status, and the error code when it is not a success. */
  const answer = async (app: { request: Hono["request"] }, path: string, init?: RequestInit) => {
    const response = await app.request(path, init);
    return response.status === 200
      ? 200
      : [response.status, ((await response.json()) as any).error.code];
  };
  const REFUSED = [403, "access_undeclared"];

  test("is refused before its handler runs, signed in or not", async () => {
    const app = createApp(t.deps).route(
      "/",
      new Hono<AppEnv>().get("/v1/test/open", handler("open")),
    );
    for (const headers of [{}, person.headers]) {
      expect(await answer(app, "/v1/test/open", { headers })).toEqual(REFUSED);
    }
    expect(ran).not.toContain("open");
  });

  test("is refused when the declaration is not the first thing it runs", async () => {
    const app = createApp(t.deps).route(
      "/",
      new Hono<AppEnv>().post("/v1/test/late", passThrough, access.user, handler("late")),
    );
    expect(await answer(app, "/v1/test/late", { method: "POST", headers: person.headers })).toEqual(
      REFUSED,
    );
  });

  test("is covered by its area saying it is for signed-in people, who must then sign in", async () => {
    const area = new Hono<AppEnv>().use(access.user).get("/inside", handler("inside"));
    const app = createApp(t.deps).route("/v1/test/area", area);

    expect(await answer(app, "/v1/test/area/inside")).toEqual([401, "unauthenticated"]);
    expect(await answer(app, "/v1/test/area/inside", { headers: person.headers })).toBe(200);
  });

  test("is not opened by an area that says it is public", async () => {
    // Two files under one prefix: share links, which anyone may open, and boards, where one
    // route forgot its declaration.
    const shareLinks = new Hono<AppEnv>().use(access.public).get("/shared/:token", handler("link"));
    const boards = new Hono<AppEnv>().delete("/:id", handler("delete"));
    const app = createApp(t.deps)
      .route("/v1/test/boards", shareLinks)
      .route("/v1/test/boards", boards);

    expect(await answer(app, "/v1/test/boards/ab_1", { method: "DELETE" })).toEqual(REFUSED);
    // Public is said on the route, so the area's own route is refused too until it says so.
    expect(await answer(app, "/v1/test/boards/shared/abc")).toEqual(REFUSED);
    expect(ran).not.toContain("delete");
    expect(ran).not.toContain("link");
  });

  test("is not opened by a public area mounted beside or above it", async () => {
    const things = new Hono<AppEnv>().use(access.public).get("/", access.public, handler("things"));
    const admin = new Hono<AppEnv>().get("/secret", handler("secret"));
    const nested = createApp(t.deps).route("/v1/things", things).route("/v1/things/admin", admin);
    expect(await answer(nested, "/v1/things")).toBe(200);
    expect(await answer(nested, "/v1/things/admin/secret")).toEqual(REFUSED);

    // An area at the root with a wildcard, registered before every other area.
    const root = new Hono<AppEnv>().use("*", access.public);
    const later = new Hono<AppEnv>().get("/later", handler("later"));
    const app = createApp(t.deps).route("/", root).route("/v1/test", later);
    expect(await answer(app, "/v1/test/later")).toEqual(REFUSED);

    expect(ran).not.toContain("secret");
    expect(ran).not.toContain("later");
  });

  test("is not opened by a public route that merely matches it", async () => {
    const routes = new Hono<AppEnv>()
      .get("/v1/test/files/*", access.public, passThrough)
      .get("/v1/test/files/private", handler("private"))
      .post("/v1/test/files/*", handler("upload"));
    const app = createApp(t.deps).route("/", routes);

    expect(await answer(app, "/v1/test/files/private")).toEqual(REFUSED);
    expect(await answer(app, "/v1/test/files/x", { method: "POST" })).toEqual(REFUSED);
    expect(ran).not.toContain("private");
    expect(ran).not.toContain("upload");
  });

  test("public said on the route opens that route, with whatever it runs after", async () => {
    const routes = new Hono<AppEnv>().get(
      "/v1/test/welcome",
      access.public,
      passThrough,
      handler("welcome"),
    );
    expect(await answer(createApp(t.deps).route("/", routes), "/v1/test/welcome")).toBe(200);
  });

  test("an area with an error handler of its own is refused whole", async () => {
    // Hono wraps every handler of such an area, the declaration with them, so nothing in it
    // can be told to be one. The app's error handler is the only one (README).
    const area = new Hono<AppEnv>()
      .get("/", access.public, handler("own-errors"))
      .onError((_error, c) => c.text("handled here", 500));
    const app = createApp(t.deps).route("/v1/test/own-errors", area);

    expect(await answer(app, "/v1/test/own-errors")).toEqual(REFUSED);
    expect(ran).not.toContain("own-errors");
  });

  test("every route the app ships is declared, and none is made public by its area", () => {
    const shipped = createApp(t.deps);
    expect(
      shipped.routes.filter((route) => route.method === "ALL" && route.handler === access.public),
    ).toEqual([]);

    const routes = shipped.routes.filter(
      (route) => route.method !== "ALL" && route.path.startsWith("/v1/"),
    );
    expect(routes.length).toBeGreaterThan(3);
    for (const { method, path } of routes) {
      // Everything a request to this route would run, in order, without the app's own
      // middleware (which is registered for every path).
      const sample = path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
      const chain = shipped.router
        .match(method, sample)[0]
        .map(([[, route]]) => route)
        .filter((route) => route.path !== "/*");
      const undeclared = firstUndeclared(chain);
      // Named in the failure, so the route that forgot is the one reported.
      expect(undeclared && `${undeclared.method} ${undeclared.path}`).toBeUndefined();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { createDesign, createRunnerToken, revokeRunnerTokens, upsertWorkspace } from "@ponzu/db";
import { Hono } from "hono";
import { createApp } from "../create-app.ts";
import type { AppEnv } from "../http/context.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";
import { access } from "./access.ts";

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
    const expired = await t.workos.signAccessToken(session(), { expiresIn: -1 });
    expect(await me(`Bearer ${expired}`)).toEqual([401, "token_expired"]);
  });

  test("a token expires five minutes after it was issued, by the API's own clock", async () => {
    const other = await createTestApp();
    const fresh = await other.signInAs();
    const ask = async () => (await other.app.request("/v1/me", { headers: fresh.headers })).status;

    other.clock.advance(299_000);
    expect(await ask()).toBe(200);
    other.clock.advance(2_000);
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

describe("a route for a runner", () => {
  // No runner route exists yet, so this mounts one the way a later module will.
  const withRunnerRoute = () => {
    const routes = new Hono<AppEnv>().get("/v1/test/design", access.runner, (c) =>
      c.json({ designId: c.var.actor.designId }),
    );
    return createApp(t.deps).route("/", routes);
  };

  async function design() {
    const workspace = await upsertWorkspace(t.db, {
      githubAccountId: Math.floor(Math.random() * 1e9),
      githubLogin: "north-brook",
      kind: "org",
      name: "North Brook",
      avatarUrl: null,
      installationId: Math.floor(Math.random() * 1e9),
      repositorySelection: "all",
      installedByUserId: null,
    });
    return createDesign(t.db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: person.userId,
      claudeAccountId: null,
      name: "Lisbon",
      branch: null,
      doc: emptyDoc("Lisbon"),
    });
  }

  test("takes a runner token and is told the one design it is for", async () => {
    const app = withRunnerRoute();
    const { id: designId } = await design();
    const { token } = await createRunnerToken(t.db, { designId, ttlSeconds: 600 });

    const response = await app.request("/v1/test/design", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ designId });
  });

  test("refuses no token, a made-up one, a revoked one and a person's", async () => {
    const app = withRunnerRoute();
    const { id: designId } = await design();
    const { token } = await createRunnerToken(t.db, { designId, ttlSeconds: 600 });
    await revokeRunnerTokens(t.db, designId);
    const ask = async (authorization?: string) => {
      const response = await app.request("/v1/test/design", {
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

describe("a route that does not say who may call it", () => {
  let ran = false;
  const undeclared = new Hono<AppEnv>()
    .get("/v1/test/open", (c) => {
      ran = true;
      return c.json({ leaked: true });
    })
    // Declared, but only after something of the route's own has run.
    .post(
      "/v1/test/late",
      (_c, next) => next(),
      access.user,
      (c) => c.json({}),
    )
    .use("/v1/test/area/*", access.public)
    .get("/v1/test/area/inside", (c) => c.json({ ok: true }));
  const app = () => createApp(t.deps).route("/", undeclared);

  test("is refused before its handler runs, signed in or not", async () => {
    for (const headers of [{}, person.headers]) {
      const response = await app().request("/v1/test/open", { headers });
      expect(response.status).toBe(403);
      expect(((await response.json()) as any).error.code).toBe("access_undeclared");
    }
    expect(ran).toBe(false);
  });

  test("is refused when the declaration is not the first thing it runs", async () => {
    const response = await app().request("/v1/test/late", {
      method: "POST",
      headers: person.headers,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe("access_undeclared");
  });

  test("is covered by a declaration on its whole area", async () => {
    const response = await app().request("/v1/test/area/inside");
    expect(response.status).toBe(200);
  });

  test("every route the app ships declares one", async () => {
    const shipped = createApp(t.deps);
    const paths = new Set(
      shipped.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    );
    expect(paths.size).toBeGreaterThan(0);
    for (const entry of paths) {
      const [method, path] = entry.split(" ") as [string, string];
      const response = await shipped.request(path, { method });
      // Named in the failure, so the route that forgot is the one reported.
      expect(`${entry}: ${response.status}`).not.toBe(`${entry}: 403`);
    }
  });
});

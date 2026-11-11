import { describe, expect, test } from "bun:test";
import { encodeBase64url } from "./base64url.ts";
import { ApiError } from "./errors.ts";
import {
  createSession,
  expiresAt,
  type KeyValueStorage,
  SESSION_KEY,
  SessionStorageError,
} from "./session.ts";
import { FakeClock } from "./testing/clock.ts";

const API = "https://api.test";
const WORKOS = "https://api.workos.com/user_management/authenticate";
const user = { id: "usr_1", githubLogin: "maya", name: "Maya", email: null, avatarUrl: null };

/** A WorkOS access token that runs out at `exp` (seconds). Unsigned: the client never checks. */
function jwt(exp: number, n: number): string {
  const part = (value: object) => encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: "RS256" })}.${part({ sub: "user_1", exp, n })}.sig`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class MemoryStorage implements KeyValueStorage {
  map = new Map<string, string>();
  /** Fail this many writes before working again. */
  failWrites = 0;
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("disk full");
    }
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  saved() {
    const text = this.map.get(SESSION_KEY);
    return text ? (JSON.parse(text) as { accessToken: string; refreshToken: string }) : null;
  }
}

/**
 * A session against a WorkOS and an API played by `answer`. WorkOS hands out `at_<n>` and
 * `rt_<n>`, each access token good for five minutes; `workos` overrides what it says.
 */
async function harness(opts: {
  /** Seconds the stored access token has left; no session stored when undefined. */
  left?: number;
  api?: (request: Request, call: number) => Response | Promise<Response>;
  workos?: (body: { refresh_token: string }, call: number) => Response | Promise<Response> | null;
}) {
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  if (opts.left !== undefined) {
    const accessToken = jwt(Math.floor(clock.now() / 1000) + opts.left, 0);
    storage.map.set(SESSION_KEY, JSON.stringify({ accessToken, refreshToken: "rt_0", user }));
  }
  const refreshes: string[] = [];
  const requests: Request[] = [];
  let issued = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === WORKOS) {
      const body = (await request.json()) as { refresh_token: string; client_id: string };
      expect(body.client_id).toBe("client_test");
      refreshes.push(body.refresh_token);
      const override = opts.workos?.(body, refreshes.length);
      if (override) return override;
      issued++;
      return json(200, {
        access_token: jwt(Math.floor(clock.now() / 1000) + 300, issued),
        refresh_token: `rt_${issued}`,
      });
    }
    requests.push(request);
    return (await opts.api?.(request, requests.length)) ?? json(200, { ok: true });
  };
  const session = createSession({
    apiUrl: API,
    workosClientId: "client_test",
    storage,
    fetch,
    clock,
    client: { platform: "macos", version: "2.0.0" },
  });
  await clock.advance(0);
  const bearer = (request: Request) => request.headers.get("authorization")?.replace("Bearer ", "");
  return { clock, storage, session, refreshes, requests, bearer };
}

describe("signing in and out", () => {
  test("starts signed out with nothing stored, and signed in with a stored session", async () => {
    expect((await harness({})).session.getState()).toEqual({ status: "signed_out" });
    expect((await harness({ left: 200 })).session.getState()).toEqual({
      status: "signed_in",
      user,
    });
  });

  test("the exchange stores both tokens before the session says it is signed in", async () => {
    const { session, storage, requests } = await harness({
      api: () => json(200, { user, access_token: jwt(9e9, 1), refresh_token: "rt_x" }),
    });
    const seen: unknown[] = [];
    session.subscribe(() => seen.push([session.getState().status, storage.saved()?.refreshToken]));

    expect(await session.completeSignIn({ code: "c0de", codeVerifier: "v".repeat(43) })).toEqual(
      user,
    );
    expect(seen).toEqual([["signed_in", "rt_x"]]);
    const [exchange] = requests;
    expect(exchange!.url).toBe(`${API}/v1/auth/exchange`);
    expect(await exchange!.json()).toEqual({ code: "c0de", code_verifier: "v".repeat(43) });
    expect(exchange!.headers.get("x-ponzu-client")).toBe("macos/2.0.0");
  });

  test("a refused exchange is the API's error, and nothing is stored", async () => {
    const { session, storage } = await harness({
      api: () => json(400, { error: { code: "invalid_code", message: "Start again." } }),
    });
    const error = await session
      .completeSignIn({ code: "x", codeVerifier: "v".repeat(43) })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("invalid_code");
    expect(storage.saved()).toBeNull();
    expect(session.getState().status).toBe("signed_out");
  });

  test("signing out ends the session at the API with its token, then forgets it", async () => {
    const { session, storage, requests, bearer } = await harness({ left: 200 });
    const token = storage.saved()!.accessToken;
    await session.signOut();
    expect(requests.map((r) => [r.method, r.url, bearer(r)])).toEqual([
      ["POST", `${API}/v1/auth/sign-out`, token],
    ]);
    expect(storage.saved()).toBeNull();
    expect(session.getState()).toEqual({ status: "signed_out" });
  });

  test("signing out offline still forgets the session here", async () => {
    const { session, storage } = await harness({
      left: 200,
      api: () => Promise.reject(new TypeError("offline")),
    });
    await session.signOut();
    expect(storage.saved()).toBeNull();
    expect(session.getState().status).toBe("signed_out");
  });
});

describe("every request", () => {
  test("carries a bearer and says which client it is", async () => {
    const { session, requests, bearer } = await harness({ left: 200 });
    await session.fetch(`${API}/v1/me`);
    expect(bearer(requests[0]!)).toBeTruthy();
    expect(requests[0]!.headers.get("x-ponzu-client")).toBe("macos/2.0.0");
  });

  test("signed out, nothing is sent", async () => {
    const { session, requests } = await harness({});
    const error = await session.fetch(`${API}/v1/me`).catch((e) => e);
    expect([error.status, error.code, requests.length]).toEqual([401, "unauthenticated", 0]);
  });
});

describe("refreshing", () => {
  test("a token with under a minute left is refreshed first, and stored before it is used", async () => {
    let storedWhenUsed: string | undefined;
    const h = await harness({
      left: 30,
      api: () => {
        storedWhenUsed = h.storage.saved()?.refreshToken;
        return json(200, {});
      },
    });
    await h.session.fetch(`${API}/v1/me`);
    expect(h.refreshes).toEqual(["rt_0"]);
    expect(storedWhenUsed).toBe("rt_1");
    expect(expiresAt(h.bearer(h.requests[0]!)!)).toBe(h.clock.now() + 300_000);
  });

  test("a token with time left is used as it is", async () => {
    const { session, refreshes } = await harness({ left: 200 });
    await session.fetch(`${API}/v1/me`);
    expect(refreshes).toEqual([]);
  });

  test("many callers at once share one refresh", async () => {
    const { session, refreshes, requests, bearer } = await harness({ left: 10 });
    await Promise.all([1, 2, 3, 4].map(() => session.fetch(`${API}/v1/me`)));
    expect(refreshes).toEqual(["rt_0"]);
    expect(new Set(requests.map(bearer)).size).toBe(1);
  });

  test("a 401 token_expired mid-flight refreshes once and sends each request again", async () => {
    // The stored token has time left by its claims, but the API says it has run out.
    let old: string | undefined;
    const h = await harness({
      left: 200,
      api: (request) =>
        h.bearer(request) === old
          ? json(401, { error: { code: "token_expired", message: "Expired." } })
          : json(200, { ok: true }),
    });
    old = h.storage.saved()!.accessToken;
    const answers = await Promise.all([
      h.session.fetch(`${API}/v1/me`),
      h.session.fetch(`${API}/v1/workspaces`),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(h.refreshes).toEqual(["rt_0"]);
    expect(h.requests).toHaveLength(4);
  });

  test("a second token_expired after the retry is the caller's error, not a loop", async () => {
    const { session, refreshes } = await harness({
      left: 200,
      api: () => json(401, { error: { code: "token_expired", message: "Expired." } }),
    });
    const error = await session.fetch(`${API}/v1/me`).catch((e) => e);
    expect(error.code).toBe("token_expired");
    expect(refreshes).toEqual(["rt_0"]);
  });

  test("a rotated pair that cannot be stored is not used, and is stored first next time", async () => {
    const h = await harness({ left: 10 });
    h.storage.failWrites = 3;
    const failing = h.session.fetch(`${API}/v1/me`).catch((e) => e);
    await h.clock.advance(5_000);
    expect(await failing).toBeInstanceOf(SessionStorageError);
    expect(h.requests).toHaveLength(0);
    // The old refresh token is spent at WorkOS: the new one lives only in memory until stored.
    expect(h.storage.saved()?.refreshToken).toBe("rt_0");

    await h.session.fetch(`${API}/v1/me`);
    expect(h.storage.saved()?.refreshToken).toBe("rt_1");
    expect(h.refreshes).toEqual(["rt_0"]);
    expect(h.requests).toHaveLength(1);
  });

  test("a storage hiccup is retried before the caller hears of it", async () => {
    const h = await harness({ left: 10 });
    h.storage.failWrites = 1;
    const answer = h.session.fetch(`${API}/v1/me`);
    await h.clock.advance(1_000);
    expect((await answer).status).toBe(200);
    expect(h.storage.saved()?.refreshToken).toBe("rt_1");
  });

  test("a transient failure is retried with the same refresh token", async () => {
    const h = await harness({
      left: 10,
      workos: (_body, call) => (call === 1 ? json(503, {}) : call === 2 ? json(429, {}) : null),
    });
    const answer = h.session.fetch(`${API}/v1/me`);
    await h.clock.advance(5_000);
    expect((await answer).status).toBe(200);
    expect(h.refreshes).toEqual(["rt_0", "rt_0", "rt_0"]);
  });

  test("WorkOS out of reach for every try is a network error; the session stays", async () => {
    const h = await harness({ left: 10, workos: () => json(502, {}) });
    const answer = h.session.fetch(`${API}/v1/me`).catch((e) => e);
    await h.clock.advance(5_000);
    expect((await answer).code).toBe("network");
    expect(h.session.getState().status).toBe("signed_in");
    expect(h.storage.saved()?.refreshToken).toBe("rt_0");
  });

  test("invalid_grant is signed out: the stored session is forgotten", async () => {
    const h = await harness({
      left: 10,
      workos: () =>
        json(400, { error: "invalid_grant", error_description: "Session has already ended." }),
    });
    const error = await h.session.fetch(`${API}/v1/me`).catch((e) => e);
    expect([error.status, error.code]).toEqual([401, "unauthenticated"]);
    expect(h.session.getState()).toEqual({ status: "signed_out" });
    expect(h.storage.saved()).toBeNull();
    expect(h.requests).toHaveLength(0);
  });
});

describe("what the API's errors mean for the session", () => {
  const answering = (status: number, code: string, details?: object) =>
    harness({
      left: 200,
      api: () => json(status, { error: { code, message: "Said so.", details } }),
    });

  for (const code of ["session_unknown", "token_invalid"]) {
    test(`${code}: signed out, and the stored session forgotten`, async () => {
      const { session, storage } = await answering(401, code);
      const error = await session.fetch(`${API}/v1/me`).catch((e) => e);
      expect([error.status, error.code, error.message]).toEqual([401, code, "Said so."]);
      await Promise.resolve();
      expect(session.getState()).toEqual({ status: "signed_out" });
      expect(storage.saved()).toBeNull();
    });
  }

  test("github_reauth_required: sign in again to re-grant GitHub", async () => {
    const { session, storage } = await answering(401, "github_reauth_required");
    expect((await session.fetch(`${API}/v1/me`).catch((e) => e)).code).toBe(
      "github_reauth_required",
    );
    expect(session.getState()).toEqual({ status: "github_reauth" });
    expect(storage.saved()).toBeNull();
  });

  test("426 client_too_old: this app is too old, with the version that is enough", async () => {
    const { session } = await answering(426, "client_too_old", { minimumVersion: "2.1.0" });
    expect((await session.fetch(`${API}/v1/me`).catch((e) => e)).status).toBe(426);
    expect(session.getState()).toEqual({ status: "too_old", minimumVersion: "2.1.0" });
  });

  const passThrough: [number, string][] = [
    [400, "invalid_request"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "nothing_to_undo"],
    [409, "last_admin"],
    [410, "ops_pruned"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [502, "upstream_unavailable"],
    [503, "database_unavailable"],
  ];
  for (const [status, code] of passThrough) {
    test(`${status} ${code}: the caller's error, carrying its code; still signed in`, async () => {
      const { session } = await answering(status, code);
      const error = await session.fetch(`${API}/v1/x`).catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect([error.status, error.code]).toEqual([status, code]);
      expect(error.transient).toBe(status === 429 || status >= 500);
      expect(session.getState().status).toBe("signed_in");
    });
  }

  test("an answer that is not the API's JSON still becomes an ApiError", async () => {
    const { session } = await harness({
      left: 200,
      api: () => new Response("<html>", { status: 502 }),
    });
    const error = await session.fetch(`${API}/v1/me`).catch((e) => e);
    expect([error.status, error.code, error.transient]).toEqual([502, "internal", true]);
  });

  test("no answer at all is a network error", async () => {
    const { session } = await harness({
      left: 200,
      api: () => Promise.reject(new TypeError("down")),
    });
    const error = await session.fetch(`${API}/v1/me`).catch((e) => e);
    expect([error.status, error.code, error.transient]).toEqual([0, "network", true]);
  });
});

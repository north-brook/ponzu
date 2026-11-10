import { expect, test } from "bun:test";
import { CommitRefusedError } from "@ponzu/core";
import { ApiError } from "./api.ts";
import { HttpRunnerApi } from "./http.ts";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** An API that answers from `reply` and keeps what it was sent. */
function api(reply: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? undefined),
    };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  const http = new HttpRunnerApi({
    baseUrl: "https://api.test",
    designId: "des_1",
    token: "pzr_secret",
    client: "runner/0.1.0",
    fetch: fake,
  });
  return { http, seen };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, code: string) =>
  json({ error: { code, message: `It was ${code}.` } }, status);

test("every call carries the runner token, the client and JSON", async () => {
  const { http, seen } = api(() => json({ events: [], seq: 3 }));
  expect(await http.claim({ restart: true })).toEqual({ events: [], seq: 3 });
  expect(seen[0]).toEqual({
    method: "POST",
    url: "https://api.test/v1/runner/events/claim",
    headers: {
      authorization: "Bearer pzr_secret",
      "x-ponzu-client": "runner/0.1.0",
      "content-type": "application/json",
    },
    body: { restart: true },
  });
});

test("each method is its route", async () => {
  const { http, seen } = api((s) =>
    s.url.endsWith("/state") ? json({ seq: 1 }) : new Response(null, { status: 204 }),
  );
  await http.ack(["evt_1"]);
  await http.putState({ state: "idle", status: null, artboards: [], claudeSessionId: null });
  await http.withdraw(["q_1"]);
  await http.eraseGitCredential({ protocol: "https", host: "github.com", path: "n/f.git" });
  await http.recordUsage([]);
  expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
    "POST /v1/runner/events/ack",
    "PUT /v1/runner/state",
    "POST /v1/runner/questions/withdraw",
    "POST /v1/runner/git-credential/erase",
    "POST /v1/runner/usage",
  ]);
});

test("an error answer becomes an ApiError with its code, and says whether to try again", async () => {
  const { http } = api(() => error(401, "token_invalid"));
  const err = await http.session().catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({
    status: 401,
    code: "token_invalid",
    message: "It was token_invalid.",
  });
  expect(err.transient).toBe(false);
  expect(new ApiError(503, "database_unavailable", "").transient).toBe(true);
  expect(new ApiError(429, "rate_limited", "").transient).toBe(true);
});

test("the document routes speak the replica's transport", async () => {
  let status = 400;
  const { http, seen } = api((s) =>
    s.url.includes("after=7") ? error(410, "gone") : error(status, "invalid_request"),
  );
  await expect(http.sync.commit([])).rejects.toBeInstanceOf(CommitRefusedError);
  status = 502;
  await expect(http.sync.commit([])).rejects.toBeInstanceOf(ApiError);
  expect(await http.sync.fetchOps(7)).toBe("gone");
  expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`)).toEqual(
    [
      "POST /v1/designs/des_1/ops",
      "POST /v1/designs/des_1/ops",
      "GET /v1/designs/des_1/ops?after=7",
    ],
  );
});

test("an upload asks where, puts the bytes there without the token, then confirms", async () => {
  const { http, seen } = api((s) => {
    if (s.url.endsWith("/uploads"))
      return json({
        files: [
          {
            id: "up_1",
            put: { url: "https://r2.test/put?sig=1", headers: { "content-type": "image/png" } },
            expiresAt: "",
          },
        ],
      });
    if (s.url.startsWith("https://r2.test")) return new Response(null, { status: 200 });
    return json({
      files: [{ id: "up_1", ref: "assets/logo.png", url: "https://assets.test/k/logo.png" }],
    });
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const [stored] = await http.upload([
    { purpose: "asset", name: "logo.png", contentType: "image/png", bytes },
  ]);
  expect(stored).toEqual({
    name: "logo.png",
    ref: "assets/logo.png",
    url: "https://assets.test/k/logo.png",
  });
  expect(seen[0]?.body).toEqual({
    files: [
      {
        purpose: "asset",
        name: "logo.png",
        contentType: "image/png",
        size: 3,
        sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      },
    ],
  });
  expect(seen[1]).toMatchObject({ method: "PUT", headers: { "content-type": "image/png" } });
  expect(seen[1]?.headers.authorization).toBeUndefined();
  expect(seen[2]?.body).toEqual({ ids: ["up_1"] });
});

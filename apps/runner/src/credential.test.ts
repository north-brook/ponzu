import { expect, test } from "bun:test";
import { formatCredential, helper, parseRequest } from "./credential.ts";

const ASK = "protocol=https\nhost=github.com\npath=north/fern.git\n\n";

function endpoint(reply: (path: string, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    return reply(path, body);
  }) as typeof globalThis.fetch;
  return {
    endpoint: { baseUrl: "https://api.test", token: "pzr_x", client: "runner/0", fetch },
    calls,
  };
}

test("git's request is read by key, with the path useHttpPath adds", () => {
  expect(parseRequest(ASK)).toEqual({
    protocol: "https",
    host: "github.com",
    path: "north/fern.git",
  });
});

test("get answers with the API's token and when git should drop it", async () => {
  const { endpoint: e, calls } = endpoint(() =>
    Response.json({
      username: "x-access-token",
      password: "ghs_abc",
      expiresAt: "2026-11-10T12:00:00Z",
    }),
  );
  expect(await helper("get", ASK, e)).toBe(
    "username=x-access-token\npassword=ghs_abc\npassword_expiry_utc=1794312000\n",
  );
  expect(calls).toEqual([
    {
      path: "/v1/runner/git-credential",
      body: { protocol: "https", host: "github.com", path: "north/fern.git" },
    },
  ]);
});

test("erase tells the API, and store keeps nothing", async () => {
  const { endpoint: e, calls } = endpoint(() => new Response(null, { status: 204 }));
  expect(await helper("erase", ASK, e)).toBe("");
  expect(await helper("store", ASK, e)).toBe("");
  expect(calls.map((c) => c.path)).toEqual(["/v1/runner/git-credential/erase"]);
});

test("a refusal is an error, so git gets no credential", async () => {
  const { endpoint: e } = endpoint(() =>
    Response.json({ error: { code: "forbidden", message: "Not this design's." } }, { status: 403 }),
  );
  await expect(helper("get", ASK, e)).rejects.toThrow("Not this design's.");
});

test("the expiry is in seconds", () => {
  expect(
    formatCredential({ username: "u", password: "p", expiresAt: "1970-01-01T00:01:00Z" }),
  ).toBe("username=u\npassword=p\npassword_expiry_utc=60\n");
});

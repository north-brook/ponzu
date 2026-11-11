import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./api/api.ts";
import type { GitCredentialRequest } from "./api/protocol.ts";
import { formatCredential, helper, parseRequest } from "./credential.ts";
import { serveCredentials } from "./server.ts";

const ASK = "protocol=https\nhost=github.com\npath=north/fern.git\n\n";
const REQUEST = { protocol: "https", host: "github.com", path: "north/fern.git" };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

/** The runner's side of the socket, answering as `get` and `erase` say. */
async function runner(answers: {
  get?: (ask: GitCredentialRequest) => Promise<{
    username: string;
    password: string;
    expiresAt: string;
  }>;
  erase?: (ask: GitCredentialRequest) => Promise<void>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-git-"));
  const path = join(dir, "git.sock");
  const calls: { op: string; ask: GitCredentialRequest }[] = [];
  const server = serveCredentials({
    path,
    get: async (ask) => {
      calls.push({ op: "get", ask });
      return answers.get!(ask);
    },
    erase: async (ask) => {
      calls.push({ op: "erase", ask });
      await answers.erase?.(ask);
    },
  });
  cleanup.push(
    () => server.stop(),
    () => rm(dir, { recursive: true, force: true }),
  );
  return { path, calls };
}

test("git's request is read by key, with the path useHttpPath adds", () => {
  expect(parseRequest(ASK)).toEqual(REQUEST);
});

test("get answers with the token the runner got, and when git should drop it", async () => {
  const { path, calls } = await runner({
    get: async () => ({
      username: "x-access-token",
      password: "ghs_abc",
      expiresAt: "2026-11-10T12:00:00Z",
    }),
  });
  expect(await helper("get", ASK, path)).toBe(
    "username=x-access-token\npassword=ghs_abc\npassword_expiry_utc=1794312000\n",
  );
  expect(calls).toEqual([{ op: "get", ask: REQUEST }]);
});

test("erase tells the runner, and store keeps nothing", async () => {
  const { path, calls } = await runner({});
  expect(await helper("erase", ASK, path)).toBe("");
  expect(await helper("store", ASK, path)).toBe("");
  expect(calls).toEqual([{ op: "erase", ask: REQUEST }]);
});

test("the API's refusal reaches git as an error, so git gets no credential", async () => {
  const { path } = await runner({
    get: async () => {
      throw new ApiError(403, "forbidden", "Not this design's.");
    },
  });
  await expect(helper("get", ASK, path)).rejects.toThrow("Not this design's.");
});

test("a runner that is not listening is an error too", async () => {
  await expect(helper("get", ASK, join(tmpdir(), "ponzu-no-runner.sock"))).rejects.toThrow();
});

test("the socket replaces one a dead runner left, and only its owner and group may open it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-git-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "git.sock");
  await writeFile(path, "left behind");
  const server = serveCredentials({
    path,
    get: async () => Promise.reject(),
    erase: async () => {},
  });
  cleanup.push(() => server.stop());
  expect(statSync(path).isSocket()).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o660);
});

test("the expiry is in seconds", () => {
  expect(
    formatCredential({ username: "u", password: "p", expiresAt: "1970-01-01T00:01:00Z" }),
  ).toBe("username=u\npassword=p\npassword_expiry_utc=60\n");
});

import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCredentialRequest, GitCredentialResponse } from "./api/protocol.ts";
import { fingerprint, GitCredentials, type Probe, receivePackProbe } from "./git-token.ts";
import { serveCredentials } from "./server.ts";

/*
 * The failure of 2026-11-11, played again: GitHub knew a token minted that instant but did not
 * yet let it see the repository's contents, so `git push` got "Repository not found". Here a
 * real git pushes through Ponzu's real credential helper and the runner's socket to a git server
 * that, like GitHub then, answers 404 "Repository not found." to a token for its first moments.
 */

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterAll(() => {
  for (const stop of stops) stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "ponzu[bot]",
  GIT_COMMITTER_EMAIL: "bot@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The API's side: mints a new token when asked, reuses it until it is erased, as GitTokens does. */
function mintingApi(minted: Map<string, number>) {
  let held: GitCredentialResponse | null = null;
  let n = 0;
  const erased: GitCredentialRequest[] = [];
  return {
    erased,
    gitCredential: async (): Promise<GitCredentialResponse> => {
      if (!held) {
        const password = `ghs_${++n}_${crypto.randomUUID()}`;
        minted.set(password, Date.now());
        held = {
          username: "x-access-token",
          password,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      }
      return held;
    },
    eraseGitCredential: async (ask: GitCredentialRequest) => {
      erased.push(ask);
      held = null;
    },
  };
}

/**
 * A git server over HTTP (git's own `http-backend`) in front of a bare repository at
 * `/north/fern.git`, with GitHub's manners: no credential is a 401 that asks for one, an unknown
 * one is a 401, and a known one younger than `freshMs` is a 404 "Repository not found.".
 */
function gitServer(minted: Map<string, number>, freshMs: number) {
  const root = temp("ponzu-gitsrv-");
  const bare = join(root, "north", "fern.git");
  sh(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  sh(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "fern\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "First");
  sh(seed, "push", "-q", bare, "main");
  const backend = join(sh(root, "--exec-path"), "git-http-backend");
  const refused: number[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      const ask = () =>
        new Response("Authentication required", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="GitHub"' },
        });
      if (!auth?.startsWith("Basic ")) return ask();
      const [, password = ""] = atob(auth.slice(6)).split(":");
      const at = minted.get(password);
      if (at === undefined) return ask();
      if (Date.now() - at < freshMs) {
        refused.push(Date.now() - at);
        return new Response("Repository not found.\n", {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const out = await cgi(
        backend,
        {
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "x-access-token",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
          GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
        },
        body,
      );
      return out;
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/north/fern.git`, bare, refused };
}

/** Runs a CGI program and answers its response. */
function cgi(program: string, env: Record<string, string>, body: Uint8Array): Promise<Response> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [], { env: { ...process.env, ...env } });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const headEnd = split >= 0 ? split : all.indexOf("\n\n");
      const gap = split >= 0 ? 4 : 2;
      const head = all.subarray(0, headEnd).toString("utf8");
      const headers = new Headers();
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers.append(name, value);
      }
      resolve(new Response(all.subarray(headEnd + gap), { status, headers }));
    });
    child.stdin.end(body);
  });
}

/** A checkout of the server's repository with a new commit on the canvas's branch. */
function checkout(server: { bare: string }) {
  const work = join(temp("ponzu-gitwork-"), "fern");
  sh(server.bare, "clone", "-q", server.bare, work);
  sh(work, "switch", "-qc", "pz/onboarding");
  writeFileSync(join(work, "flow.html"), "<p>Welcome</p>\n");
  sh(work, "add", ".");
  sh(work, "commit", "-qm", "Add the onboarding flow");
  return work;
}

/** `git push` to `url` with Ponzu's helper asking the runner on `socket`, as the sandbox's git does. */
function push(work: string, url: string, socket: string): Promise<{ ok: boolean; said: string }> {
  const helper = `!'${process.execPath}' '${join(import.meta.dir, "credential.ts")}' '${socket}'`;
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "-c",
        "credential.useHttpPath=true",
        "push",
        url,
        "pz/onboarding",
      ],
      { cwd: work, env: ENV },
    );
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ ok: code === 0, said }));
  });
}

/** The runner's credential socket, answered by `credentials`. */
function socketFor(credentials: GitCredentials): string {
  // A unix socket's path has a short limit on macOS.
  const path = join(mkdtempSync("/tmp/pzgit-"), "git.sock");
  dirs.push(join(path, ".."));
  const served = serveCredentials({
    path,
    get: (ask) => credentials.get(ask),
    erase: (ask) => credentials.erase(ask),
  });
  stops.push(() => served.stop());
  return path;
}

test("as it was: a push the instant the canvas's first token is minted gets 'Repository not found'", async () => {
  const minted = new Map<string, number>();
  const server = gitServer(minted, 1_500);
  const api = mintingApi(minted);
  // No check: the token goes to git as the API hands it out, as before the fix.
  const credentials = new GitCredentials({ api, probe: async () => 200, event: () => {} });
  const work = checkout(server);

  const pushed = await push(work, server.url, socketFor(credentials));

  expect(pushed.ok).toBe(false);
  expect(pushed.said).toContain("remote: Repository not found.");
  expect(pushed.said).toContain("not found");
  // git never asks to erase after a 404, so nothing tells the API the token was refused.
  expect(api.erased).toEqual([]);
});

test("a push the instant the canvas's first token is minted lands: the runner waits until GitHub honours it", async () => {
  const minted = new Map<string, number>();
  const server = gitServer(minted, 1_500);
  const api = mintingApi(minted);
  const events: Record<string, unknown>[] = [];
  const credentials = new GitCredentials({
    api,
    probe: receivePackProbe(),
    event: (name, fields) => events.push({ name, ...fields }),
  });
  const work = checkout(server);

  const pushed = await push(work, server.url, socketFor(credentials));

  expect(pushed).toMatchObject({ ok: true });
  expect(sh(server.bare, "rev-parse", "refs/heads/pz/onboarding")).toBe(
    sh(work, "rev-parse", "HEAD"),
  );
  // GitHub refused the new token at first, and git got it only once GitHub honoured it.
  expect(server.refused.length).toBeGreaterThan(0);
  expect(events.at(-1)).toMatchObject({ name: "git_credential_ready" });
  expect(events.filter((e) => e.name === "git_credential_refused").length).toBeGreaterThan(0);
  // The log names tokens by fingerprint, never by the token.
  expect(JSON.stringify(events)).not.toContain("ghs_");
});

/* ------------------------------------------------------------------ */
/* The check, step by step                                             */
/* ------------------------------------------------------------------ */

const ASK = { protocol: "https", host: "github.com", path: "north/fern.git" };

function scripted(statuses: (number | null)[]) {
  const minted = new Map<string, number>();
  const api = mintingApi(minted);
  const asked: string[] = [];
  const probe: Probe = async (_ask, credential) => {
    asked.push(credential.password);
    return statuses.length ? statuses.shift()! : 200;
  };
  const events: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const credentials = new GitCredentials({
    api,
    probe,
    event: (name, fields) => events.push({ name, ...fields }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { api, asked, events, slept, credentials };
}

test("a token GitHub honours is handed out at once, and again without asking GitHub", async () => {
  const s = scripted([200]);
  const first = await s.credentials.get(ASK);
  const again = await s.credentials.get(ASK);
  expect(again).toEqual(first);
  expect(s.asked).toHaveLength(1);
  expect(s.slept).toEqual([]);
  expect(s.events).toEqual([
    {
      name: "git_credential_ready",
      fingerprint: fingerprint(first.password),
      checks: 1,
      ms: expect.any(Number),
    },
  ]);
});

test("a token GitHub refuses for a moment is waited for; one it keeps refusing is given back", async () => {
  const waited = scripted([404, 404, 200]);
  const token = await waited.credentials.get(ASK);
  expect(new Set(waited.asked)).toEqual(new Set([token.password]));
  expect(waited.slept).toEqual([500, 1_000]);
  expect(waited.api.erased).toEqual([]);

  const replaced = scripted([404, 404, 404, 404, 200]);
  const fresh = await replaced.credentials.get(ASK);
  expect(replaced.api.erased).toEqual([
    { ...ASK, reason: "GitHub's git answered 404 to the runner's check, 4 times" },
  ]);
  expect(replaced.asked.at(-1)).toBe(fresh.password);
  expect(replaced.asked[0]).not.toBe(fresh.password);
});

test("when GitHub can't be asked, or keeps refusing past the budget, git gets the token anyway", async () => {
  const down = scripted([null]);
  await down.credentials.get(ASK);
  expect(down.events).toMatchObject([{ name: "git_credential_unchecked", status: null }]);

  const refusing = scripted(Array(20).fill(403));
  const token = await refusing.credentials.get(ASK);
  expect(token.password).toStartWith("ghs_");
  expect(refusing.events.at(-1)).toMatchObject({ name: "git_credential_unready" });
  // About fifteen seconds in all, inside the helper's thirty.
  expect(refusing.slept.reduce((a, b) => a + b, 0)).toBeLessThan(20_000);
});

test("git's own erase reaches the API, and what was honoured is checked again", async () => {
  const s = scripted([200, 200]);
  await s.credentials.get(ASK);
  await s.credentials.erase(ASK);
  expect(s.api.erased).toEqual([ASK]);
  await s.credentials.get(ASK);
  expect(s.asked).toHaveLength(2);
});

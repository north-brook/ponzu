/*
 * What the image's trials do to a Vercel Sandbox from this machine, on @vercel/sandbox itself:
 * credentials, a command and its output, the runner's start, the fake API beside it, and the
 * runner's public address with its bearer.
 *
 * Credentials: VERCEL_TOKEN if it is set, else the signed-in Vercel CLI's token, read in this
 * process by the SDK's own reader of the CLI's auth file (`@vercel/sandbox/dist/auth`); with
 * VERCEL_TEAM_ID and VERCEL_API_PROJECT_ID (the API's project, which owns the sandboxes and
 * the image). Never printed or written. Inside the API on Vercel it is OIDC instead, which the
 * SDK reads by itself.
 *
 * Secrets go in a command's `env`, never in its arguments: `sh` refuses a command holding the
 * value of any secret in this process's environment, as harness.ts does.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, Sandbox } from "@vercel/sandbox";
import { getAuth } from "@vercel/sandbox/dist/auth/index.js";
import { bundle, redact, scratch, secretsIn, secretValues, until } from "./harness.ts";

export const RUNNER_PORT = 4600;
export const FAKE_API_PORT = 8790;
const FAKE_DIR = "/vercel/fake-api";
export const OUT = join(import.meta.dir, "..", "..", "..", ".context", "vercel");

export function credentials(): { token: string; teamId: string; projectId: string } {
  const teamId = need("VERCEL_TEAM_ID");
  const projectId = need("VERCEL_API_PROJECT_ID");
  const token = process.env.VERCEL_TOKEN ?? getAuth()?.token;
  if (!token) throw new Error("Set VERCEL_TOKEN, or sign the Vercel CLI in (vercel login).");
  return { token, teamId, projectId };
}

export function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** One line of what was measured, printed and kept in .context/vercel/results.jsonl. */
export function note(event: string, data: Record<string, unknown> = {}): void {
  mkdirSync(OUT, { recursive: true });
  const line = redact(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  console.log(line);
  appendFileSync(join(OUT, "results.jsonl"), `${line}\n`);
}

export const now = () => performance.now();
export const secs = (ms: number) => Math.round(ms) / 1000;

/** Runs a shell command and answers its output; `env` carries anything secret. */
export async function sh(
  sb: Sandbox,
  script: string,
  opts: { sudo?: boolean; env?: Record<string, string>; ok?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
  const found = secretsIn(script, secretValues(process.env));
  if (found.length) throw new Error(`refusing a command holding ${found.join(", ")}: use env`);
  const t0 = now();
  const r = await sb.runCommand({
    cmd: "bash",
    args: ["-c", script],
    sudo: opts.sudo,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const out = {
    exitCode: r.exitCode,
    stdout: await r.stdout(),
    stderr: await r.stderr(),
    ms: now() - t0,
  };
  if (opts.ok !== false && out.exitCode !== 0)
    throw new Error(
      `${script.split("\n")[0]} exited ${out.exitCode}: ${redact(out.stderr.slice(-1500))}`,
    );
  return out;
}

/** What one design's sandbox is given at every start: never at create, never on disk. */
export interface Start {
  designId: string;
  runnerToken: string;
  portToken: string;
  credential: Record<string, string>;
}

export function newStart(credential: Record<string, string>): Start {
  return {
    designId: `des_${randomBytes(8).toString("hex")}`,
    runnerToken: `pzr_${randomBytes(18).toString("base64url")}`,
    portToken: `pzp_${randomBytes(24).toString("base64url")}`,
    credential,
  };
}

/** The runner's environment, as the API would give the start command. */
export function runnerEnv(start: Start, apiUrl: string): Record<string, string> {
  return {
    PONZU_API_URL: apiUrl,
    PONZU_DESIGN_ID: start.designId,
    PONZU_RUNNER_TOKEN: start.runnerToken,
    PONZU_PORT_TOKEN: start.portToken,
    ...start.credential,
  };
}

/**
 * Starts the runner's supervisor as the API would: a detached command, as root, with the
 * runner's environment for that command only. Its output streams to a local file.
 */
export async function startRunner(sb: Sandbox, env: Record<string, string>, logFile: string) {
  const t0 = now();
  const cmd = await sb.runCommand({
    cmd: "/opt/ponzu/bin/ponzu-start",
    sudo: true,
    detached: true,
    env,
  });
  follow(cmd, logFile);
  return { cmd, startMs: now() - t0 };
}

/** Copies a detached command's output to `file` as it comes, redacted. */
export function follow(cmd: Command, file: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "", { flag: "a" });
  void (async () => {
    try {
      for await (const log of cmd.logs()) appendFileSync(file, redact(log.data));
    } catch (err) {
      appendFileSync(file, `\n[follow ended: ${String(err)}]\n`);
    }
  })();
}

/** Bundles the fake API and puts it in the sandbox. Once per sandbox: the disk keeps it. */
export async function installFakeApi(sb: Sandbox): Promise<void> {
  await scratch(async (dir) => {
    await bundle(join(import.meta.dir, "sandbox", "fake-api.ts"), dir, "fake-api.js");
    const bytes = await Bun.file(join(dir, "fake-api.js")).bytes();
    await sh(sb, `mkdir -p ${FAKE_DIR}`);
    await sb.writeFiles([{ path: `${FAKE_DIR}/fake-api.js`, content: bytes }]);
  });
}

/** Starts the fake API as the sandbox's own user, before the runner, as the API is always up. */
export async function startFakeApi(sb: Sandbox, start: Start, logFile: string) {
  const cmd = await sb.runCommand({
    cmd: "/opt/ponzu/bin/bun",
    args: [`${FAKE_DIR}/fake-api.js`],
    detached: true,
    env: {
      PONZU_DESIGN_ID: start.designId,
      PONZU_RUNNER_TOKEN: start.runnerToken,
      PONZU_PORT_TOKEN: start.portToken,
      PONZU_FAKE_API_STATE: `${FAKE_DIR}/state.json`,
    },
  });
  follow(cmd, logFile);
  return cmd;
}

/** The runner's public address and the fake API's. */
export function addresses(sb: Sandbox) {
  return { runner: sb.domain(RUNNER_PORT), api: sb.domain(FAKE_API_PORT) };
}

export async function health(runnerUrl: string, portToken: string) {
  const r = await fetch(`${runnerUrl}/health`, {
    headers: { authorization: `Bearer ${portToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  return r.ok ? ((await r.json()) as { ok: true; state: string }) : null;
}

export async function control<T = unknown>(
  apiUrl: string,
  start: Start,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // A port's address can answer 502 for a moment right after a wake, though it answered once.
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${apiUrl}/control/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${start.runnerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (![502, 503].includes(r.status) || attempt >= 20) break;
    note("control.retry", { path, status: r.status, attempt });
    await Bun.sleep(100);
  }
  if (!r.ok) throw new Error(`${method} /control/${path}: ${r.status}`);
  if (r.status === 204) return undefined as T;
  const type = r.headers.get("content-type") ?? "";
  return (type.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer())) as T;
}

export { Sandbox, until };

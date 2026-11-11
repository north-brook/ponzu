/*
 * What checks.ts, e2e.ts and durability.ts do to a Vercel Sandbox from this machine, on
 * @ponzu/sandbox (never the SDK itself): credentials, a command and its output, the runner bundle
 * served by the runner's fake API beside it (sandbox/fake-api.ts), the runner's start and stop as
 * the API does them, and removing every sandbox it made, on Ctrl-C too.
 *
 * Credentials: VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (the ponzu-api project, which
 * owns the sandboxes and the image), all three. Never printed or written.
 *
 * Secrets go in a command's `env`, never in its text: `sh` refuses a command holding the value of
 * any secret in this process's environment or the shape of a key.
 *
 * Every sandbox is named `pz-test-<tag>-<8 random>`, which no sweep matches, and is removed.
 */
import { spawnSync } from "node:child_process";
import { createHash, createSign, randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type At,
  type Sandboxes,
  type SandboxSpec,
  systemClock,
  testSandboxName,
  type Up,
  type VercelCredentials,
  vercelSandboxes,
} from "@ponzu/sandbox";
import {
  IMAGE_COMMANDS,
  type RestoredReport,
  RUNNER_PORT,
  type RunnerSession,
  type SavedPoint,
  type StartEnv,
  type StateRequest,
  type ThreadItem,
  type TurnUsage,
} from "../src/api/protocol.ts";
import { ROOT, RUNNER } from "./image.ts";

export { RUNNER_PORT };
export const FAKE_API_PORT = 8790;
const FAKE_DIR = "/vercel/fake-api";
/** What the API gives ponzu-stop. */
export const STOP_COMMAND_MS = 30_000;

/* ── credentials and the module ── */

export function credentials(): VercelCredentials {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId)
    throw new Error("Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (ponzu-api's).");
  return { token, teamId, projectId };
}

let module: Sandboxes | null = null;
export function sandboxes(): Sandboxes {
  module ??= vercelSandboxes({ clock: systemClock, credentials: credentials() });
  return module;
}

/* ── what this process made ── */

const made = new Set<string>();

/** Removes every sandbox this process made and has not removed yet. */
export async function removeAll(): Promise<void> {
  await Promise.allSettled(
    [...made].map(async (name) => {
      await sandboxes().remove(name);
      made.delete(name);
    }),
  );
}

/** On Ctrl-C or SIGTERM, remove every sandbox this process made before exiting. */
export function removeOnSignal(): void {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.error(`\n${signal}: removing ${[...made].join(", ") || "nothing"}`);
      void removeAll().then(() => process.exit(130));
    });
}

/* ── one sandbox ── */

/** A sandbox and the session every call pins to; `at` moves at every up(). */
export interface Box {
  name: string;
  spec: SandboxSpec;
  at: At;
  urls: Record<number, string>;
  /** What the last up() said. */
  up: Up;
}

export function testSpec(image: string, opts: { persistent?: boolean; timeoutMs?: number } = {}) {
  const persistent = opts.persistent ?? true;
  return {
    image,
    persistent,
    ports: [RUNNER_PORT, FAKE_API_PORT],
    timeoutMs: opts.timeoutMs ?? 45 * 60_000,
    vcpus: 2,
    // A day: these are removed at the end, and a forgotten one goes on its own.
    ...(persistent ? { snapshotExpirationMs: 24 * 3600_000 } : {}),
  } satisfies SandboxSpec;
}

/** Makes (or resumes) `pz-test-<tag>-…`. */
export async function upBox(tag: string, spec: SandboxSpec): Promise<Box> {
  const name = testSandboxName(tag);
  made.add(name);
  const up = await sandboxes().up(name, spec);
  return { name, spec, at: { name, sessionId: up.sessionId }, urls: up.urls, up };
}

/** up() again, as the API's wake: a new session when it was stopped. */
export async function reUp(box: Box): Promise<Up> {
  const up = await sandboxes().up(box.name, box.spec);
  box.up = up;
  box.at = { name: box.name, sessionId: up.sessionId };
  box.urls = up.urls;
  return up;
}

export async function removeBox(box: Box): Promise<void> {
  await sandboxes().remove(box.name);
  made.delete(box.name);
}

export class CommandError extends Error {
  override name = "CommandError";
}

/** Runs a bash script, waited, and answers its output. A non-zero exit throws unless `ok: false`. */
export async function sh(
  box: Box,
  script: string,
  opts: { sudo?: boolean; env?: Record<string, string>; ok?: false; timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; ms: number }> {
  refuseSecrets(script);
  const t0 = performance.now();
  const r = await sandboxes().exec(box.at, {
    cmd: "bash",
    args: ["-c", script],
    ...(opts.sudo ? { sudo: true } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });
  const out = { ...r, ms: performance.now() - t0 };
  if (opts.ok !== false && r.exitCode !== 0)
    throw new CommandError(
      `${script.split("\n")[0]} exited ${r.exitCode}\n${redact(`${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-25).join("\n"))}`,
    );
  return out;
}

/* ── the runner bundle, the fake API and the runner ── */

export interface Bundle {
  sha256: string;
  tgz: Uint8Array;
  requires: { claude: string; playwrightCore: string };
}

/** Builds the runner bundle as the API's build does, into a scratch folder. */
export function buildRunnerBundle(): Bundle {
  const out = mkdtempSync(join(tmpdir(), "ponzu-runner-bundle-"));
  try {
    const built = spawnSync(process.execPath, ["scripts/build.ts", "--outdir", out], {
      cwd: RUNNER,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (built.status !== 0) throw new Error("the runner bundle did not build");
    const meta = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8")) as Bundle & {
      tgz: string;
    };
    const tgz = new Uint8Array(readFileSync(join(out, "runner.tgz")));
    if (createHash("sha256").update(tgz).digest("hex") !== meta.sha256)
      throw new Error("runner.tgz is not the bundle.json it came with");
    return { sha256: meta.sha256, tgz, requires: meta.requires };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** What one design's sandbox is given at every start: never at create, never on disk. */
export interface Start {
  designId: string;
  runnerToken: string;
  portToken: string;
  bundle: string;
  credential: { ANTHROPIC_API_KEY: string };
}

export function newStart(bundle: Bundle, anthropicKey: string): Start {
  return {
    designId: `des_${randomBytes(8).toString("hex")}`,
    runnerToken: `pzr_${randomBytes(18).toString("base64url")}`,
    portToken: randomBytes(32).toString("base64url"),
    bundle: bundle.sha256,
    credential: { ANTHROPIC_API_KEY: anthropicKey },
  };
}

/** The start command's environment, as the API gives it, pointed at the fake API on localhost. */
export function startEnv(start: Start, bundle = start.bundle): Record<string, string> {
  const env = {
    PONZU_API_URL: `http://127.0.0.1:${FAKE_API_PORT}`,
    PONZU_DESIGN_ID: start.designId,
    PONZU_RUNNER_TOKEN: start.runnerToken,
    PONZU_PORT_TOKEN: start.portToken,
    PONZU_RUNNER_BUNDLE: bundle,
    ...start.credential,
  } satisfies StartEnv;
  return env;
}

/** Puts the fake API and the runner bundle it serves in the sandbox. Once: the disk keeps them. */
export async function installFakeApi(box: Box, bundle: Bundle): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-fake-api-"));
  try {
    await bundleEntry(join(import.meta.dir, "sandbox", "fake-api.ts"), dir, "fake-api.js");
    await sh(box, `mkdir -p ${FAKE_DIR}`);
    await sandboxes().writeFile(
      box.at,
      `${FAKE_DIR}/fake-api.js`,
      new Uint8Array(readFileSync(join(dir, "fake-api.js"))),
    );
    await sandboxes().writeFile(box.at, `${FAKE_DIR}/runner.tgz`, bundle.tgz);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Starts the fake API as the sandbox's own user, before the runner, as the API is always up, and
 * waits until it answers through its public address. `hold`: it answers the runner 503 until the
 * driver hands back the memory it kept (`PUT /control/memory`).
 */
export async function startFakeApi(box: Box, start: Start, opts: { hold?: boolean } = {}) {
  await sandboxes().start(box.at, {
    cmd: "bash",
    args: ["-c", `exec /opt/ponzu/bin/bun ${FAKE_DIR}/fake-api.js >> ${FAKE_DIR}/log 2>&1`],
    env: {
      PONZU_DESIGN_ID: start.designId,
      PONZU_RUNNER_TOKEN: start.runnerToken,
      PONZU_PORT_TOKEN: start.portToken,
      PONZU_FAKE_API_STATE: `${FAKE_DIR}/state.json`,
      PONZU_FAKE_API_BUNDLE: `${FAKE_DIR}/runner.tgz`,
      ...(opts.hold ? { PONZU_FAKE_API_HOLD: "1" } : {}),
    },
  });
  await until("the fake API", () => record(box, start), 60_000, 100);
}

/** ponzu-start, as the API's wake: root, detached, the runner's environment in its env only. */
export async function startRunner(box: Box, start: Start): Promise<number> {
  const t0 = performance.now();
  await sandboxes().start(box.at, {
    cmd: IMAGE_COMMANDS.start,
    env: startEnv(start),
    sudo: true,
  });
  return performance.now() - t0;
}

/** As the API's sleep: ponzu-stop (waited), then stop(). Answers how long each took. */
export async function sleepLikeTheApi(box: Box) {
  const t0 = performance.now();
  const stop = await sandboxes().exec(box.at, {
    cmd: IMAGE_COMMANDS.stop,
    sudo: true,
    timeoutMs: STOP_COMMAND_MS,
  });
  const ponzuStopMs = performance.now() - t0;
  if (stop.exitCode !== 0) throw new Error(`ponzu-stop exited ${stop.exitCode}: ${stop.stderr}`);
  const t1 = performance.now();
  const stopped = await sandboxes().stop(box.at);
  const stopMs = performance.now() - t1;
  const status = await sandboxes().status(box.name);
  return {
    ponzuStopMs: secs(ponzuStopMs),
    stopMs: secs(stopMs),
    stopped: stopped.stopped,
    snapshotMiB:
      stopped.snapshotBytes === null ? null : Math.round(stopped.snapshotBytes / 2 ** 20),
    statusAfter: status?.status ?? null,
  };
}

/** `/health` through the runner's public address, with the port's bearer: what the API sees. */
export async function health(
  box: Box,
  start: Start,
): Promise<{ started: boolean; state?: string } | null> {
  const r = await fetch(`${box.urls[RUNNER_PORT]}/health`, {
    headers: { authorization: `Bearer ${start.portToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  return r.ok ? ((await r.json()) as { started: boolean; state?: string }) : null;
}

/** A call to the fake API's control routes through its public address. */
export async function control<T = unknown>(
  box: Box,
  start: Start,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // A port's address can answer 502 for a moment right after a start, though it answered once.
  let r!: Response;
  for (let attempt = 0; attempt <= 20; attempt++) {
    r = await fetch(`${box.urls[FAKE_API_PORT]}/control/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${start.runnerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (![502, 503].includes(r.status) || r.headers.get("content-type")?.includes("json")) break;
    await Bun.sleep(100);
  }
  if (!r.ok) throw new Error(`${method} /control/${path}: ${r.status}`);
  if (r.status === 204) return undefined as T;
  const type = r.headers.get("content-type") ?? "";
  return (type.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer())) as T;
}

/** What the fake API recorded (sandbox/fake-api.ts, `GET /control/record`). */
export interface Recorded {
  now: number;
  /** When the fake API started: every session start restarts it. */
  started: number;
  held: boolean;
  items: ThreadItem[];
  states: (StateRequest & { at: number })[];
  usage: TurnUsage[];
  uploads: { index: number; purpose: string; name: string; contentType: string; size: number }[];
  delivered: string[];
  events: string[];
  session: Omit<RunnerSession, "runnerId" | "seq">;
  doc: { doc: { pages: { artboards: { id: string; name: string }[] }[] }; seq: number };
  saved: SavedPoint | null;
  checkpoints: { turn: number; claudeSessionId: string | null; wipCommit: string | null }[];
  restored: RestoredReport[];
  claims: number[];
  bundles: number;
  kept: { writes: number; restored: { writes: number; feedSeq: number; savedTurn: number | null } };
}

export function record(box: Box, start: Start): Promise<Recorded> {
  return control<Recorded>(box, start, "GET", "record");
}

/** A person's message, as the API adds it to the feed and pokes the runner. */
export function message(box: Box, start: Start, text: string): Promise<{ id: string }> {
  return control(box, start, "POST", "events", { kind: "message", payload: { text } });
}

/** The fake keeps no thread across a start of the sandbox, so "since" is by time and start. */
export interface Mark {
  started: number;
  now: number;
}
export const mark = (r: Recorded): Mark => ({ started: r.started, now: r.now });

export function newer(r: Recorded, from: Mark): ThreadItem[] {
  return r.items.filter((i) => r.started !== from.started || Date.parse(i.at) > from.now);
}

export function statesSince(r: Recorded, from: Mark): string[] {
  return r.states.filter((s) => r.started !== from.started || s.at > from.now).map((s) => s.state);
}

export function assistantText(r: Recorded, from: Mark): string | null {
  const item = newer(r, from).find(
    (i) => i.kind === "assistant" && (i.payload as { text: string }).text.trim(),
  );
  return item ? (item.payload as { text: string }).text : null;
}

/** The runner has its session, Claude Code is up, it is not held, and it has nothing to do. */
export function idle(box: Box, start: Start, what: string, ms = 180_000): Promise<Recorded> {
  return until(
    what,
    async () => {
      const r = await record(box, start);
      const up = r.items.some(
        (i) =>
          i.kind === "notice" &&
          ["started", "resumed"].includes((i.payload as { type: string }).type),
      );
      return up && !r.held && r.states.at(-1)?.state === "idle" ? r : null;
    },
    ms,
    300,
  );
}

/** The turn the event started has ended: taken, worked, idle, and (if asked) previews drawn. */
export function afterTurn(
  box: Box,
  start: Start,
  eventId: string,
  from: Mark,
  opts: { previews?: number; ms?: number } = {},
): Promise<Recorded> {
  return until(
    "the turn to end",
    async () => {
      const r = await record(box, start);
      const states = statesSince(r, from);
      const done =
        r.delivered.includes(eventId) &&
        states.includes("working") &&
        states.at(-1) === "idle" &&
        assistantText(r, from) !== null &&
        !r.items.some((i) => i.streaming);
      const drawn = r.uploads.filter((u) => u.purpose === "preview").length >= (opts.previews ?? 0);
      return done && drawn ? r : null;
    },
    opts.ms ?? 5 * 60_000,
    300,
  );
}

/** The runner's log (/var/log/ponzu/runner.log, root's to read), its last lines matching. */
export async function runnerLog(box: Box, pattern = "."): Promise<string[]> {
  const r = await sh(
    box,
    `grep -E ${shellQuote(pattern)} /var/log/ponzu/runner.log | tail -60; echo; tail -c 2000 ${FAKE_DIR}/log`,
    { sudo: true, ok: false },
  ).catch((e) => ({ stdout: String(e) }));
  return redact(r.stdout).split("\n").filter(Boolean);
}

/* ── GitHub, as the App: a one-hour token for one repository, as the API mints it ── */

export async function installationToken(repo: string) {
  const jwt = appJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${need("GITHUB_APP_INSTALLATION_ID")}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", metadata: "read" },
      }),
    },
  );
  if (!response.ok) throw new Error(`GitHub refused an installation token: ${response.status}`);
  const body = (await response.json()) as { token: string; expires_at: string };
  return { jwt, token: body.token, expiresAt: body.expires_at };
}

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { iat: now - 60, exp: now + 540, iss: need("GITHUB_APP_ID") };
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}`;
  const key = readFileSync(need("GITHUB_APP_PRIVATE_KEY_PATH"), "utf8");
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
}

export async function gh<T = unknown>(token: string, path: string, method = "GET"): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/**
 * The session a repo design's runner gets: GITHUB_TEST_REPO on a new branch, authored as
 * E2E_PERSON (the App's bot when unset) and committed as the App's bot.
 */
export async function repoSession(github: { jwt: string; token: string }, branch: string) {
  const [owner, name] = need("GITHUB_TEST_REPO").split("/") as [string, string];
  const { slug } = await gh<{ slug: string }>(github.jwt, "/app");
  const bot = await gh<{ login: string; id: number }>("", `/users/${slug}%5Bbot%5D`);
  const person = process.env.E2E_PERSON
    ? await gh<{ login: string; id: number }>("", `/users/${process.env.E2E_PERSON}`)
    : bot;
  const repository = await gh<{ default_branch: string }>(github.token, `/repos/${owner}/${name}`);
  const noreply = (u: { login: string; id: number }) => ({
    name: u.login,
    email: `${u.id}+${u.login}@users.noreply.github.com`,
  });
  return {
    owner,
    name,
    session: {
      repo: { owner, name, defaultBranch: repository.default_branch },
      branch,
      author: noreply(person),
      committer: noreply(bot),
    } satisfies Partial<RunnerSession>,
  };
}

/* ── secrets ── */

/** Key shapes, cut out of anything printed: a sandbox's output is shown as it comes. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…")
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, "gh_…")
    .replace(/pzr_[A-Za-z0-9_-]{8,}/g, "pzr_…")
    .replace(/vcp_[A-Za-z0-9_-]{8,}/g, "vcp_…")
    .replace(/_token=[A-Za-z0-9._-]+/g, "_token=…");
}

/** A variable whose name says it holds a secret. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL/i;

/**
 * The values of the secrets in `env`, by name: every variable whose name says it is one, long
 * enough not to turn up by chance. The App's key file is named by a path: its contents count.
 */
export function secretValues(env: NodeJS.ProcessEnv): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    if (name.endsWith("_PATH")) {
      try {
        values.set(name, readFileSync(value, "utf8").trim());
      } catch {}
    } else if (value.length >= 12) values.set(name, value);
  }
  return values;
}

/** The names of the secrets whose shape or value `text` holds. */
export function secretsIn(text: string, secrets: Map<string, string>): string[] {
  const found = [...secrets].filter(([, value]) => text.includes(value)).map(([name]) => name);
  if (redact(text) !== text) found.push("a key's shape");
  return found;
}

/** Each file under `dir` that holds one of `secrets`, with the names it holds. */
export function filesWithSecrets(dir: string, secrets: Map<string, string>): string[] {
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const path = join(at, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(dir).flatMap((path) => {
    const text = readFileSync(path, "latin1");
    const names = [...secrets].filter(([, v]) => text.includes(v)).map(([n]) => n);
    return names.length ? [`${path} (${names.join(", ")})`] : [];
  });
}

function refuseSecrets(command: string): void {
  const found = secretsIn(command, secretValues(process.env));
  if (found.length)
    throw new Error(`refusing to send a command holding ${found.join(", ")}: use env instead`);
}

/* ── small things ── */

/** Builds `entry` into one file for the sandbox's Bun, beside playwright-core rather than with it. */
export async function bundleEntry(entry: string, outdir: string, name: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    naming: name,
    outdir,
    external: ["playwright-core"],
  });
  if (!built.success) throw new AggregateError(built.logs, `could not build ${entry}`);
}

/** Waits for `check` to return something, or throws once `ms` have passed. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  ms: number,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    const got = await check().catch((err) => {
      last = err;
      return undefined;
    });
    if (got) return got;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}${last ? ` (last: ${String(last)})` : ""}`);
    await Bun.sleep(everyMs);
  }
}

export const secs = (ms: number) => Math.round(ms) / 1000;

export function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** One line of what was measured, printed and kept in .context/image/<run>.jsonl. */
export function note(run: string, event: string, data: Record<string, unknown> = {}): void {
  const dir = join(ROOT, ".context", "image");
  mkdirSync(dir, { recursive: true });
  const line = redact(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  console.log(line);
  appendFileSync(join(dir, `${run}.jsonl`), `${line}\n`);
}

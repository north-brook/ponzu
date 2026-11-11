/*
 * A sandbox made from the image to try it, with the runner's fake API running beside the
 * runner (sandbox/fake-api.ts): the runner reaches it on localhost, through the environment the
 * real API will give it, and this machine drives it through the sandbox's token-gated
 * addresses. Only for checks and trials: the fake's unit is never part of the image.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxAddress, SandboxProvider } from "@ponzu/sandbox";
import type {
  RestoredReport,
  RunnerSession,
  SavedPoint,
  StateRequest,
  ThreadItem,
  TurnUsage,
} from "../src/api/protocol.ts";
import { bundle, forget, scratch, sh, since, track, until, upload } from "./harness.ts";

export const RUNNER_PORT = 4600;
export const FAKE_API_PORT = 8790;
const FAKE_DIR = "/home/user/ponzu-fake-api";

export interface Trial {
  boat: SandboxProvider;
  id: string;
  designId: string;
  /** The fake API's bearer, which is the runner token: in the sandbox's environment only. */
  token: string;
  runner: SandboxAddress;
  api: SandboxAddress;
  /** Seconds from the create call to the runner's `/health` answering through its address. */
  healthAfter: number;
  /** The runner's unit when `/health` first answered, before the trial restarted it. */
  boot: { ActiveState: string; NRestarts: string };
}

/** What the fake API recorded (sandbox/fake-api.ts, `GET /control/record`). */
export interface Recorded {
  now: number;
  /** When the fake API started: a cold start restarts it with an empty thread. */
  started: number;
  items: ThreadItem[];
  states: (StateRequest & { at: number })[];
  usage: TurnUsage[];
  uploads: { index: number; purpose: string; name: string; contentType: string; size: number }[];
  delivered: string[];
  events: string[];
  session: Omit<RunnerSession, "runnerId" | "seq">;
  doc: { doc: { pages: { artboards: { id: string; name: string }[] }[] }; seq: number };
  /** How often the fake wrote its state, and what it read back when it started. */
  kept: {
    writes: number;
    restored: { writes: number; feedSeq: number; savedTurn: number | null };
  };
  /** Whether it is holding the runner off until the driver hands its memory back. */
  held: boolean;
  saved: SavedPoint | null;
  checkpoints: { turn: number; claudeSessionId: string | null; wipCommit: string | null }[];
  restored: RestoredReport[];
  quiesced: string[];
}

/**
 * Creates a sandbox from `snapshot` with the environment a design's sandbox gets (the runner
 * pointed at the fake API on localhost, and `credential`), and times it until `/health`
 * answers. Then installs the fake API, gives it the design's `session` and a `gitToken` to
 * answer git with, and restarts the runner so that its first call finds them.
 */
export async function startTrial(
  boat: SandboxProvider,
  snapshot: string,
  opts: {
    name: string;
    label: string;
    credential: Record<string, string>;
    session?: Partial<RunnerSession>;
    gitToken?: { password: string; expiresAt: string };
    autoStopSeconds?: number;
    /**
     * The fake holds the runner off after every start until the driver hands back the memory it
     * kept (`handBack`), as the real API is never on the sandbox's disk.
     */
    hold?: boolean;
  },
): Promise<Trial> {
  const designId = `des_${randomBytes(8).toString("hex")}`;
  const token = `pzr_${randomBytes(18).toString("base64url")}`;
  const start = performance.now();
  const created = await boat.create({
    idempotencyKey: `${opts.name}-${designId}`,
    from: snapshot,
    name: opts.name,
    labels: { ponzu: opts.label, image: snapshot },
    env: {
      PONZU_API_URL: `http://127.0.0.1:${FAKE_API_PORT}`,
      PONZU_DESIGN_ID: designId,
      PONZU_RUNNER_TOKEN: token,
      ...opts.credential,
    },
    ports: [RUNNER_PORT, FAKE_API_PORT],
    autoStopSeconds: opts.autoStopSeconds ?? 3600,
  });
  const id = created.sandbox.id;
  const untrack = track(boat, id);
  try {
    const address = (port: number) => {
      const found = created.addresses.find((a) => a.port === port);
      if (!found) throw new Error(`boat gave no address for port ${port}`);
      return found;
    };
    const runner = address(RUNNER_PORT);
    await until("the runner's /health", () => health(runner), 180_000);
    const healthAfter = since(start);
    const unit = await sh(boat, id, "systemctl show -p ActiveState -p NRestarts ponzu-runner", {
      quiet: true,
    });
    const boot = Object.fromEntries(
      unit
        .trim()
        .split("\n")
        .map((l) => l.split("=") as [string, string]),
    ) as Trial["boot"];
    const trial: Trial = {
      boat,
      id,
      designId,
      token,
      runner,
      api: address(FAKE_API_PORT),
      healthAfter,
      boot,
    };
    await installFakeApi(trial, { hold: opts.hold ?? false });
    if (opts.hold) await control(trial, "POST", "release");
    if (opts.session) await control(trial, "PUT", "session", opts.session);
    // Over the address's TLS, into the fake's memory: never a command, a file or a log.
    if (opts.gitToken) await control(trial, "PUT", "git-token", opts.gitToken);
    await restartRunner(trial);
    return trial;
  } catch (err) {
    // A runner that never answers is what the checks are for; its sandbox holds the real env.
    await boat.destroy(id).catch(() => {});
    untrack();
    throw err;
  }
}

/** Destroys a trial's sandbox, and stops tracking it. */
export async function endTrial(trial: Trial): Promise<void> {
  await trial.boat.destroy(trial.id);
  forget(trial.id);
}

/** `/health` through the runner's address: what the API sees. */
export async function health(runner: SandboxAddress): Promise<{ ok: true; state: string } | null> {
  const response = await fetch(`${runner.url}/health`, {
    headers: runner.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok ? ((await response.json()) as { ok: true; state: string }) : null;
}

/** A call to the fake API's control routes. */
export async function control<T = unknown>(
  trial: Trial,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${trial.api.url}/control/${path}`, {
    method,
    headers: {
      ...trial.api.headers,
      authorization: `Bearer ${trial.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} /control/${path}: ${response.status}`);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  return (
    type.includes("json") ? await response.json() : new Uint8Array(await response.arrayBuffer())
  ) as T;
}

export function record(trial: Trial): Promise<Recorded> {
  return control<Recorded>(trial, "GET", "record");
}

/** What the API keeps of a design (the fake's memory), held on this machine across a stop. */
export type Memory = Record<string, unknown>;

/**
 * Stops the sandbox as the API's idle stop does (apps/api/src/sandboxes/quiesce.ts): the stop
 * is under way and the runner is asked for a report, which tells it to get ready; it is waited
 * for (30 s at most), the disk is flushed and the sandbox stopped. Answers how long each part
 * took, and the fake's memory as of the stop, which `wakeLikeTheApi` hands back.
 */
export async function sleepLikeTheApi(trial: Trial) {
  const sleep = new Date().toISOString();
  const began = performance.now();
  await control(trial, "PUT", "sleep", { sleep });
  const quiesced = await until(
    "the runner to be ready for sleep",
    async () => (await record(trial)).quiesced.includes(sleep),
    30_000,
    200,
  ).catch(() => false);
  const quiesceSeconds = since(began);
  const memory = await control<Memory>(trial, "GET", "memory");
  const synced = performance.now();
  await sh(trial.boat, trial.id, "sync", { quiet: true });
  const syncSeconds = since(synced);
  await trial.boat.stop(trial.id);
  await until(
    "sleep",
    async () => (await trial.boat.get(trial.id)).state === "asleep",
    120_000,
    500,
  );
  return { sleep, quiesced, quiesceSeconds, syncSeconds, memory };
}

/**
 * Resumes the sandbox and hands the fake back the memory the driver kept, as the real API
 * remembers whatever the sandbox's disk does. Answers whether boat started it cold and how long
 * the runner took to answer `/health`, as the API's warm-resume check sees it.
 */
export async function wakeLikeTheApi(trial: Trial, memory: Memory) {
  const began = performance.now();
  const resumed = await until(
    "boat to take the resume",
    () =>
      trial.boat.resume(trial.id).catch((err) => {
        if (err?.code === "busy") return null;
        throw err;
      }),
    120_000,
    500,
  );
  await until("the fake API", () => record(trial), 120_000, 200);
  const fakeUpSeconds = since(began);
  const before = await record(trial);
  await control(trial, "PUT", "memory", memory);
  // Awake again: the stop is over, and a thawed runner hears it on this report.
  await control(trial, "PUT", "sleep", { sleep: null });
  await until("the runner's /health", () => health(trial.runner), 180_000, 200);
  return {
    coldStart: resumed.coldStart,
    fakeUpSeconds,
    healthSeconds: since(began),
    /** What the fake's own flushed state file said when it started: a second witness. */
    fakeFileSavedTurn: before.kept.restored.savedTurn,
    fakeFileWrites: before.kept.restored.writes,
  };
}

/** A person's message, as the API adds it to the feed and pokes the runner. */
export function message(trial: Trial, text: string): Promise<{ id: string }> {
  return control(trial, "POST", "events", { kind: "message", payload: { text } });
}

/** Restarts the runner, as a new start of the sandbox would: it calls the session route again. */
export async function restartRunner(trial: Trial): Promise<void> {
  await sh(trial.boat, trial.id, "sudo systemctl restart ponzu-runner", { quiet: true });
  await until("the runner's /health", () => health(trial.runner), 60_000);
}

async function installFakeApi(trial: Trial, { hold }: { hold: boolean }): Promise<void> {
  await scratch(async (dir) => {
    await bundle(join(import.meta.dir, "sandbox", "fake-api.ts"), dir, "fake-api.js");
    mkdirSync(join(dir, "unit"));
    const unit = hold
      ? FAKE_API_UNIT.replace("[Service]\n", "[Service]\nEnvironment=PONZU_FAKE_API_HOLD=1\n")
      : FAKE_API_UNIT;
    writeFileSync(join(dir, "unit", "ponzu-fake-api.service"), unit);
    await upload(trial.boat, trial.id, dir, FAKE_DIR);
  });
  await sh(
    trial.boat,
    trial.id,
    `sudo install -m 0644 ${FAKE_DIR}/unit/ponzu-fake-api.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ponzu-fake-api`,
    { quiet: true },
  );
  await until("the fake API", () => control(trial, "GET", "record").then(() => true), 60_000);
}

/** Starts before the runner at every boot, cold starts included, as the API is always there. */
const FAKE_API_UNIT = `[Unit]
Description=The runner's fake API (test sandboxes only)
Before=ponzu-runner.service

[Service]
User=user
Environment=HOME=/home/user
ExecStart=/bin/bash -c 'until [ -r /run/ascii-secrets/env.sh ]; do sleep 0.2; done; set -a; . /run/ascii-secrets/env.sh; set +a; exec /opt/ponzu/bin/bun ${FAKE_DIR}/fake-api.js'
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`;

#!/usr/bin/env bun
/**
 * A real check of dev after its deploy (.github/workflows/deploy-api.yml), through the API as
 * the apps use it: a Scratch canvas made with a first message, Claude's answer on Haiku at low
 * effort, the agent idle, the sandbox put to sleep by the minute, a second message waking it and
 * being answered, and the canvas deleted whatever happened.
 *
 *   CANARY_SESSION=… CRON_SECRET=… bun scripts/ci/canary.ts --session-file <path>
 *
 * It runs only against dev's apiUrl in infra/environments.json, never production's, and only as
 * a dedicated check account:
 *
 * - CANARY_SESSION is the session file `bun run dev:signin` writes (apps/api/scripts), made by
 *   signing in to dev as the check account. A refresh token works once: the session refreshes
 *   through the client's own code (packages/client/src/session.ts) and writes the rotated pair
 *   to `--session-file`, and the workflow's next step stores that file back as the secret.
 * - The account's Claude must be the development Anthropic API key, connected once by hand. The
 *   canary refuses a subscription or no Claude at all, and never connects or disconnects one,
 *   so the key is never in the deploy.
 * - It works only in the account's own personal workspace, which must have no other member, and
 *   it refuses otherwise. It touches nothing else: the one canvas it makes, there, and nothing
 *   more. The account may see other workspaces (a GitHub account is let into the workspace of
 *   every repository GitHub lets it read, a public one included), and the canary never opens
 *   them.
 * - CRON_SECRET is dev's: the canary calls the minute itself while it waits for the sleep, as
 *   Vercel would, so it does not wait on the schedule's jitter.
 *
 * With no CANARY_SESSION it prints a notice and exits 0 having done nothing: the deploy goes on
 * without a real turn, and says so. It prints no token, key or secret; what it prints is the
 * canvas id and how long each stage took.
 */
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, createApi } from "../../packages/client/src/api.ts";
import { createLive } from "../../packages/client/src/live/live.ts";
import { createSession } from "../../packages/client/src/session.ts";
import { sessionFile } from "../../packages/client/src/testing/session-file.ts";
import { apiUrlOf } from "./health.ts";

const ROOT = join(import.meta.dir, "../..");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** What the canary runs on: the cheapest model at its lowest effort. */
export const MODEL = "claude-haiku-5-5";
export const EFFORT = "low";

export const FIRST =
  "This is an automated check. Reply with the single word ready, and do nothing else.";
export const SECOND_MESSAGE =
  "This is an automated check. Reply with the single word again, and do nothing else.";

type CanaryApi = Pick<Api, "me" | "claude" | "workspaces" | "canvases">;

export interface Canary {
  api: CanaryApi;
  /** The sandbox's state as the canvas's head row has it: `awake`, `asleep`, or null. */
  sandboxState(canvasId: string): Promise<string | null>;
  /** Runs the minute once, as the scheduler would. */
  cron?: () => Promise<void>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** How long each wait may take. */
  answerMs?: number;
  idleMs?: number;
  sleepMs?: number;
  pollMs?: number;
}

export class CanaryError extends Error {}

/** Runs the canary once. Answers how long each stage took, in seconds from the start. */
export async function canary(deps: Canary): Promise<Record<string, number>> {
  const {
    api,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
    answerMs = 6 * MINUTE,
    idleMs = 3 * MINUTE,
    sleepMs = 9 * MINUTE,
    pollMs = 5 * SECOND,
  } = deps;
  const began = now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    marks[name] = Math.round((now() - began) / 100) / 10;
    log(`${marks[name]!.toFixed(1)} s  ${name}`);
  };
  const until = async <T>(what: string, ms: number, check: () => Promise<T | undefined>) => {
    const deadline = now() + ms;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (now() > deadline) throw new CanaryError(`Gave up waiting for ${what}.`);
      await wait(pollMs);
    }
  };

  // Where: the check account's own personal workspace (the personal one on its own GitHub
  // login), with nobody else in it. Another person's personal workspace it can see is never
  // counted or opened.
  const me = await api.me();
  const login = me.user.githubLogin.toLowerCase();
  const personal = me.workspaces.filter(
    (w) => w.kind === "personal" && w.githubLogin.toLowerCase() === login,
  );
  if (personal.length !== 1)
    throw new CanaryError(
      `The check account has ${personal.length} personal workspaces of its own; the canary works only in its own one.`,
    );
  const workspace = personal[0]!;
  const { members } = await api.workspaces.get(workspace.id);
  if (members.length !== 1 || members[0]?.userId !== me.user.id)
    throw new CanaryError("The check account's personal workspace has other members.");
  const claude = await api.claude.get();
  if (claude.account?.kind !== "api_key")
    throw new CanaryError(
      "The check account's Claude is not an API key: connect the development Anthropic API key to it once (docs/production.md).",
    );
  mark("the check account is alone in its workspace, on an API key");

  const created = await api.canvases.create({
    workspaceId: workspace.id,
    message: { text: FIRST },
    model: MODEL,
    effort: EFFORT,
    createKey: `canary-${began}`,
  });
  const canvasId = created.id;
  log(`canvas ${canvasId}`);
  mark("canvas made with its first message");
  try {
    const answers = async () =>
      (await api.canvases.thread(canvasId)).items.filter(
        (item) =>
          item.kind === "assistant" &&
          String((item.payload as { text?: unknown }).text ?? "").trim(),
      ).length;
    await until("Claude's first answer", answerMs, async () =>
      (await answers()) > 0 ? true : undefined,
    );
    mark("Claude answered");
    await until("the agent to be idle", idleMs, async () =>
      (await api.canvases.get(canvasId)).agentState === "idle" ? true : undefined,
    );
    mark("agent idle");
    await until("the sandbox to sleep", sleepMs, async () => {
      await deps.cron?.();
      return (await deps.sandboxState(canvasId)) === "asleep" ? true : undefined;
    });
    mark("sandbox asleep");
    const before = await answers();
    await api.canvases.sendMessage(canvasId, { text: SECOND_MESSAGE });
    mark("second message sent");
    await until("the sandbox to wake", answerMs, async () =>
      (await deps.sandboxState(canvasId)) === "asleep" ? undefined : true,
    );
    mark("sandbox woken");
    await until("Claude's second answer", answerMs, async () =>
      (await answers()) > before ? true : undefined,
    );
    mark("Claude answered again");
  } finally {
    await api.canvases.delete(canvasId);
    mark("canvas deleted");
  }
  return marks;
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const path = arg(process.argv.slice(2), "--session-file");
  const output = (line: string) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  };
  if (!path) {
    console.error(
      "usage: CANARY_SESSION=… CRON_SECRET=… bun scripts/ci/canary.ts --session-file <path>",
    );
    process.exit(2);
  }
  const saved = process.env.CANARY_SESSION;
  if (!saved || process.env.CANARY_CAN_SAVE !== "true") {
    console.log(
      `::notice title=No real turn on dev::${saved ? "CANARY_SESSION_WRITER is not set, so the rotated session could not be kept" : "CANARY_SESSION is not set"}; the canary did not run (docs/production.md, "The production deploy, staged").`,
    );
    output("ran=false");
    process.exit(0);
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log("::error title=No cron secret::The canary needs dev's CRON_SECRET.");
    process.exit(1);
  }
  const infra = JSON.parse(readFileSync(join(ROOT, "infra/environments.json"), "utf8"));
  const apiUrl = apiUrlOf("dev").replace(/\/$/, "");
  writeFileSync(path, saved, { mode: 0o600 });
  chmodSync(path, 0o600);
  output("ran=true");
  const session = createSession({
    apiUrl,
    workosClientId: infra.environments.dev.workosClientId,
    storage: sessionFile(path),
    client: {
      platform: "macos",
      version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    },
  });
  const api = createApi(session);
  const live = createLive({ api });
  const heads = new Map<string, string | null>();
  const watching = new Map<string, () => void>();
  try {
    const marks = await canary({
      api,
      async sandboxState(canvasId) {
        if (!watching.has(canvasId))
          watching.set(
            canvasId,
            live.subscribe("canvas.head", { canvasId }, (snapshot) =>
              heads.set(canvasId, snapshot.rows?.[0]?.sandboxState ?? null),
            ),
          );
        return heads.get(canvasId) ?? null;
      },
      cron: async () => {
        await fetch(`${apiUrl}/v1/cron/minute`, {
          headers: { authorization: `Bearer ${secret}` },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
      },
    });
    console.log(JSON.stringify(marks));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Canary on dev\n\nA real turn on ${MODEL}: ${Object.entries(marks)
          .map(([name, at]) => `${name} at ${at} s`)
          .join(", ")}.\n\n`,
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error title=The canary failed on dev::${message.replace(/[\r\n%]/g, " ")}`);
    process.exitCode = 1;
  } finally {
    for (const stop of watching.values()) stop();
    live.close();
  }
}

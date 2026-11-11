#!/usr/bin/env bun
/**
 * The runner for real in sandboxes made from the image, against its fake API inside the same
 * sandbox (trial.ts), with real Claude Code on the cheapest model:
 *
 *   bun apps/runner/image/e2e.ts scratch [snapshot]   a turn that draws, then warm and cold wakes
 *   bun apps/runner/image/e2e.ts repo [snapshot]      a checkout, a commit and a push to GitHub
 *
 * The snapshot defaults to current.json's. Both need BOAT_API_KEY and ANTHROPIC_API_KEY.
 * `scratch` takes E2E_WARM and E2E_COLD, how many wakes of each kind (2 and 2); a cold wake
 * first waits out the ten minutes boat keeps a stopped sandbox's memory. `repo` also needs
 * GITHUB_TEST_REPO (owner/name), the GitHub App's GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and
 * GITHUB_APP_PRIVATE_KEY_PATH, and E2E_PERSON, the GitHub login the commit is authored as. It
 * mints a one-hour token for that one repository, hands it to the fake API's git-credential
 * answer over the sandbox's address, and deletes the branch it pushed and the token after.
 *
 * What each step measured and asserted is printed as JSON and kept in .context/e2e/, with the
 * previews the runner uploaded. Every sandbox is destroyed.
 */
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerSession, ThreadItem } from "../src/api/protocol.ts";
import { bootChecks, imageChecks, runChecks } from "./checks.ts";
import { destroyOnSignal, provider, sh, since, until } from "./harness.ts";
import { readPins } from "./recipe.ts";
import {
  control,
  endTrial,
  health,
  message,
  type Recorded,
  record,
  startTrial,
  type Trial,
} from "./trial.ts";

const OUT = join(import.meta.dir, "..", "..", "..", ".context", "e2e");
const TURN_MS = 5 * 60_000;
/** boat keeps a stopped sandbox's memory for ten minutes; past that a resume boots. */
const COLD_AFTER_MS = 11 * 60_000;

const [phase, snapshotArg] = process.argv.slice(2);
const snapshot: string =
  snapshotArg ?? JSON.parse(readFileSync(join(import.meta.dir, "current.json"), "utf8")).snapshot;
const boat = provider();
destroyOnSignal();
const report: Record<string, unknown> = { phase, snapshot };
mkdirSync(OUT, { recursive: true });

try {
  if (phase === "scratch") await scratch();
  else if (phase === "repo") await repo();
  else throw new Error("say scratch or repo");
} finally {
  writeFileSync(join(OUT, `${phase}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function scratch(): Promise<void> {
  const trial = await startTrial(boat, snapshot, {
    name: "e2e-scratch",
    label: "image-e2e",
    credential: { ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY") },
  });
  report.sandbox = trial.id;
  report.createToHealthSeconds = trial.healthAfter;
  try {
    const from = mark(await idle(trial, "the runner to start"));
    const asked = await message(
      trial,
      "Make one small artboard, about 360 by 200, named Hello. On a light background put the word Hello in the system font (system-ui) followed by the 🎉 emoji, large. That is all: one board, one screenshot at most.",
    );
    const turn = await afterTurn(trial, asked.id, from, { previews: true });
    report.firstTurn = assertTurn(turn, from);
    await keepPreviews(trial, turn);

    report.isolation = await runChecks(bootChecks(trial));
    report.deputy = await deputyTurn(trial);

    const wakes: unknown[] = [];
    report.wakes = wakes;
    for (let i = 0; i < Number(process.env.E2E_WARM ?? 2); i++)
      wakes.push(await wake(trial, "warm", 60_000));

    // The real Claude credential was in this sandbox's environment for every turn and wake so
    // far: none of it may be on disk. Before the cold wakes, which can fail on boat's disk.
    report.secretsAfterTurns = await runChecks(
      imageChecks(boat, trial.id, readPins()).filter((c) => c.name.startsWith("nothing secret")),
    );

    for (let i = 0; i < Number(process.env.E2E_COLD ?? 2); i++)
      wakes.push(await wake(trial, "cold", COLD_AFTER_MS));
  } catch (err) {
    // What the runner and the fake API said, before the sandbox goes.
    report.journal = await sh(
      boat,
      trial.id,
      "sudo journalctl -u ponzu-runner -u ponzu-fake-api -b 0 --no-pager -o short-monotonic | grep -v pam_unix | tail -80",
      { quiet: true },
    ).catch((e) => String(e));
    report.lastRecord = await record(trial)
      .then((r) => ({
        events: r.events,
        delivered: r.delivered,
        states: r.states.map((s) => s.state),
        items: r.items.map((i) => `${i.kind} ${JSON.stringify(i.payload).slice(0, 120)}`),
      }))
      .catch((e) => String(e));
    throw err;
  } finally {
    await endTrial(trial);
  }
}

/**
 * The review's attack, through the real runner and a real turn: a link in the checkout to boat's
 * environment file, as a hostile repo could commit, handed to create_artboard by path. Nothing
 * of the runner token or the Claude key may reach the design.
 */
async function deputyTurn(trial: Trial) {
  const link = "/home/agent/work/scratch/notes.html";
  await sh(boat, trial.id, `sudo -u agent ln -sfn /run/ascii-secrets/env.sh ${link}`, {
    quiet: true,
  });
  const from = mark(await record(trial));
  const asked = await message(
    trial,
    `Call create_artboard once, with name "Notes" and path "${link}", and nothing else. Then say in one line what the tool answered.`,
  );
  const turn = await afterTurn(trial, asked.id, from);
  const doc = JSON.stringify(turn.doc);
  const leaked = [trial.token, need("ANTHROPIC_API_KEY"), "PONZU_RUNNER_TOKEN"].some((s) =>
    doc.includes(s),
  );
  const result = {
    leaked,
    tools: newer(turn, from)
      .filter((i) => i.kind === "tool")
      .map((i) => (i.payload as { label: string }).label),
    reply: (assistantText(turn, from) ?? "").slice(0, 200),
  };
  console.log(JSON.stringify(result));
  if (leaked) throw new Error("the runner's tools read the environment file for the agent");
  return result;
}

/**
 * What a stop that turns cold keeps of the files written just before it: one flushed to the disk
 * (`sync <file>`), one not. The fake API flushes its state the way the runner does.
 */
async function plantFiles(trial: Trial) {
  const nonce = Date.now().toString(36);
  await sh(
    boat,
    trial.id,
    `echo ${nonce} > ~/.ponzu-probe-synced && sync ~/.ponzu-probe-synced && echo ${nonce} > ~/.ponzu-probe-unsynced`,
    { quiet: true },
  );
  return { nonce, fakeWrites: (await record(trial)).kept.writes };
}

async function filesAfter(trial: Trial, planted: { nonce: string; fakeWrites: number }) {
  const out = await sh(
    boat,
    trial.id,
    "cat ~/.ponzu-probe-synced; echo; cat ~/.ponzu-probe-unsynced 2>/dev/null; echo",
    { quiet: true },
  );
  const [synced = "", unsynced = ""] = out.split("\n").map((l) => l.trim());
  const restored = (await record(trial)).kept.restored.writes;
  const kept = {
    syncedFileKept: synced === planted.nonce,
    unsyncedFileKept: unsynced === planted.nonce,
    fakeStateRestored: `${restored} of ${planted.fakeWrites} writes`,
  };
  // What is flushed must come back, and the fake's state with its last write.
  if (!kept.syncedFileKept || restored !== planted.fakeWrites)
    throw new Error(`a cold start lost what was on the disk: ${JSON.stringify(kept)}`);
  return kept;
}

/**
 * Stops the sandbox, waits `asleepMs`, resumes it, and times the runner coming back: `/health`
 * through its address, and the first assistant text of the turn a message sent at once starts,
 * as the API sends the message that woke it.
 */
async function wake(trial: Trial, kind: "warm" | "cold", asleepMs: number) {
  const before = await machine(trial);
  const session = (await record(trial)).session.claudeSessionId;
  const planted = kind === "cold" ? await plantFiles(trial) : null;
  await boat.stop(trial.id);
  await until("sleep", async () => (await boat.get(trial.id)).state === "asleep", 120_000, 500);
  console.log(`${kind}: asleep; resuming in ${asleepMs / 1000} s`);
  await Bun.sleep(asleepMs);

  const start = performance.now();
  // A stop can still hold the machine for a moment after it reads as asleep: boat says busy.
  const resumed = await until(
    "boat to take the resume",
    () =>
      boat.resume(trial.id).catch((err) => {
        if (err?.code === "busy") return null;
        throw err;
      }),
    120_000,
    500,
  );
  await until("the runner's /health", () => health(trial.runner), 180_000, 200);
  const healthAfter = since(start);
  const from = mark(await until("the fake API", () => record(trial), 120_000, 200));
  const disk = planted ? await filesAfter(trial, planted) : null;
  const asked = await message(
    trial,
    "Which artboard did you make earlier, and what does it say? Answer in one short line, without tools.",
  );
  // The first words of the reply, as they stream.
  await until(
    "the first assistant text",
    async () => assistantText(await record(trial), from),
    TURN_MS,
    200,
  );
  const firstTextAfter = since(start);
  const turn = await afterTurn(trial, asked.id, from);
  const reply = assistantText(turn, from) ?? "";
  const after = await machine(trial);
  const result = {
    kind,
    resumedCold: resumed.coldStart,
    bootChanged: before.boot !== after.boot,
    runnerRestarted: before.runner !== after.runner,
    sameClaudeSession: turn.session.claudeSessionId === session,
    notices: newer(turn, from)
      .filter((i) => i.kind === "notice")
      .map((i) => (i.payload as { type: string }).type),
    healthAfterSeconds: healthAfter,
    firstAssistantTextAfterSeconds: firstTextAfter,
    reply: reply.slice(0, 200),
    ...(disk ? { disk } : {}),
  };
  console.log(JSON.stringify(result));
  if (!result.sameClaudeSession || !/hello/i.test(reply))
    throw new Error(`the wake did not resume the session: ${JSON.stringify(result)}`);
  if (kind === "cold" && !result.bootChanged)
    throw new Error(`a cold wake must be a boot: ${JSON.stringify(result)}`);
  return result;
}

async function repo(): Promise<void> {
  const [owner, name] = need("GITHUB_TEST_REPO").split("/") as [string, string];
  const github = await installationToken(name);
  try {
    const branch = `pz/image-e2e-${Date.now().toString(36)}`;
    const person = await gh<{ login: string; id: number }>("", `/users/${need("E2E_PERSON")}`);
    const { slug } = await gh<{ slug: string }>(github.jwt, "/app");
    const bot = await gh<{ login: string; id: number }>("", `/users/${slug}%5Bbot%5D`);
    const repository = await gh<{ default_branch: string }>(
      github.token,
      `/repos/${owner}/${name}`,
    );
    const noreply = (u: { login: string; id: number }) => ({
      name: u.login,
      email: `${u.id}+${u.login}@users.noreply.github.com`,
    });
    const session: Partial<RunnerSession> = {
      repo: { owner, name, defaultBranch: repository.default_branch },
      branch,
      author: noreply(person),
      committer: noreply(bot),
    };
    report.session = session;
    try {
      await pushFromSandbox(session, github);
    } finally {
      await gh(github.token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, "DELETE").catch(
        (err) => console.log(`could not delete ${branch}: ${err}`),
      );
      // GitHub can still answer for a branch for a few seconds after it is deleted.
      report.branchDeleted = await until(
        "the branch to be gone",
        () =>
          gh(github.token, `/repos/${owner}/${name}/branches/${branch}`).then(
            () => false,
            () => true,
          ),
        30_000,
        2_000,
      ).catch(() => false);
    }
  } finally {
    await gh(github.token, "/installation/token", "DELETE").catch(() => {});
  }
}

async function pushFromSandbox(
  session: Partial<RunnerSession>,
  github: { token: string; expiresAt: string },
): Promise<void> {
  const { owner, name } = session.repo!;
  const trial = await startTrial(boat, snapshot, {
    name: "e2e-repo",
    label: "image-e2e",
    credential: { ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY") },
    session,
    gitToken: { password: github.token, expiresAt: github.expiresAt },
  });
  report.sandbox = trial.id;
  report.createToHealthSeconds = trial.healthAfter;
  try {
    const from = mark(await idle(trial, "the runner to check out the branch"));
    const work = `/home/agent/work/${name}`;
    // The checkout is the agent's, on the design's branch, and git asks only the runner.
    report.checkout = (
      await sh(
        boat,
        trial.id,
        `stat -c %U ${work}; sudo -u agent git -C ${work} branch --show-current; sudo -u agent git config --global --get-all credential.https://github.com.helper | tail -1`,
        { quiet: true },
      )
    )
      .trim()
      .split("\n");
    const asked = await message(
      trial,
      "In the repository, add a file named ponzu-e2e.txt holding one line: hello from a Ponzu sandbox. Commit it with the message 'chore: check the sandbox image' and push the branch. Do not draw anything.",
    );
    const turn = await afterTurn(trial, asked.id, from);
    report.turn = assertTurn(turn, from, { drew: false });

    const pushed = await gh<{ commit: { sha: string } }>(
      github.token,
      `/repos/${owner}/${name}/branches/${session.branch}`,
    );
    const commit = await gh<{
      commit: {
        message: string;
        author: { name: string; email: string };
        committer: { name: string; email: string };
      };
      files: { filename: string }[];
    }>(github.token, `/repos/${owner}/${name}/commits/${pushed.commit.sha}`);
    const people = {
      author: { name: commit.commit.author.name, email: commit.commit.author.email },
      committer: { name: commit.commit.committer.name, email: commit.commit.committer.email },
    };
    report.commit = {
      sha: pushed.commit.sha,
      message: commit.commit.message,
      files: commit.files.map((f) => f.filename),
      ...people,
    };
    const want = { author: session.author, committer: session.committer };
    if (JSON.stringify(people) !== JSON.stringify(want))
      throw new Error(`want ${JSON.stringify(want)}, got ${JSON.stringify(people)}`);
    if (!commit.files.some((f) => f.filename === "ponzu-e2e.txt"))
      throw new Error("the commit does not hold ponzu-e2e.txt");
  } finally {
    await endTrial(trial);
  }
}

/* What the fake API saw. It keeps no thread across a cold start, so "since" is by time. */

interface Mark {
  started: number;
  now: number;
}

function mark(r: Recorded): Mark {
  return { started: r.started, now: r.now };
}

function newer(r: Recorded, from: Mark): ThreadItem[] {
  return r.items.filter((i) => r.started !== from.started || Date.parse(i.at) > from.now);
}

function statesSince(r: Recorded, from: Mark): string[] {
  return r.states.filter((s) => r.started !== from.started || s.at > from.now).map((s) => s.state);
}

function assistantText(r: Recorded, from: Mark): string | null {
  const item = newer(r, from).find(
    (i) => i.kind === "assistant" && (i.payload as { text: string }).text.trim(),
  );
  return item ? (item.payload as { text: string }).text : null;
}

/** The runner has its session, Claude Code is up, and it has nothing to do. */
function idle(trial: Trial, what: string): Promise<Recorded> {
  return until(
    what,
    async () => {
      const r = await record(trial);
      const up = r.items.some(
        (i) => i.kind === "notice" && ["started", "resumed"].includes((i.payload as any).type),
      );
      return up && r.states.at(-1)?.state === "idle" ? r : null;
    },
    180_000,
    500,
  );
}

/** The turn the event started has ended: taken, worked, idle, and (if asked) previews drawn. */
function afterTurn(
  trial: Trial,
  eventId: string,
  from: Mark,
  opts: { previews?: boolean } = {},
): Promise<Recorded> {
  return until(
    "the turn to end",
    async () => {
      const r = await record(trial);
      const states = statesSince(r, from);
      const done =
        r.delivered.includes(eventId) &&
        states.includes("working") &&
        states.at(-1) === "idle" &&
        assistantText(r, from) !== null &&
        !r.items.some((i) => i.streaming);
      const drawn = r.uploads.filter((u) => u.purpose === "preview").length >= 2;
      return done && (!opts.previews || drawn) ? r : null;
    },
    TURN_MS,
    500,
  );
}

function assertTurn(r: Recorded, from: Mark, opts: { drew?: boolean } = {}) {
  const items = newer(r, from);
  const tool = items.filter((i) => i.kind === "tool").map((i) => (i.payload as any).label);
  const states = statesSince(r, from);
  const artboards = r.doc.doc.pages.flatMap((p) => p.artboards.map((a) => a.name));
  const previews = r.uploads.filter((u) => u.purpose === "preview").map((u) => u.name);
  const checks = {
    started: r.items.some((i) => i.kind === "notice" && (i.payload as any).type === "started"),
    workLine: tool.length > 0,
    assistantText: assistantText(r, from) !== null,
    workingThenIdle: states.includes("working") && states.at(-1) === "idle",
    usage: r.usage.length > 0 && r.usage.every((u) => u.models.length > 0),
    ...(opts.drew === false
      ? {}
      : {
          artboardCommitted: r.doc.seq > 0 && artboards.length > 0,
          lightAndDarkPreviews: previews.includes("light.png") && previews.includes("dark.png"),
        }),
  };
  const summary = {
    checks,
    thread: items.map((i) => `${i.kind} ${JSON.stringify(i.payload).slice(0, 160)}`),
    states,
    artboards,
    previews,
    usage: r.usage,
  };
  const missing = Object.entries(checks).filter(([, ok]) => !ok);
  if (missing.length)
    throw new Error(`missing ${missing.map(([k]) => k).join(", ")}: ${JSON.stringify(summary)}`);
  return summary;
}

/** The light and dark previews, pulled back to look at. */
async function keepPreviews(trial: Trial, r: Recorded): Promise<void> {
  const files: string[] = [];
  for (const upload of r.uploads.filter((u) => u.purpose === "preview")) {
    const path = join(OUT, `preview-${upload.index}-${upload.name}`);
    writeFileSync(path, await control<Uint8Array>(trial, "GET", `uploads/${upload.index}`));
    files.push(path);
  }
  report.previewFiles = files;
}

/** The machine's boot and the runner's process, to tell a thaw from a boot. */
async function machine(trial: Trial): Promise<{ boot: string; runner: string }> {
  const out = await sh(
    boat,
    trial.id,
    "cat /proc/sys/kernel/random/boot_id; systemctl show -p MainPID --value ponzu-runner",
    { quiet: true },
  );
  const [boot = "", runner = ""] = out.trim().split("\n");
  return { boot, runner };
}

/* GitHub, as the App: a one-hour token for one repository, as the API would mint it. */

async function installationToken(repo: string) {
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

async function gh<T = unknown>(token: string, path: string, method = "GET"): Promise<T> {
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

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

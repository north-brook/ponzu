#!/usr/bin/env bun
/**
 * What a sandbox keeps across sleeps and lost disks, for real, in sandboxes made from the image
 * (docs/cloud.md, "Saving the sandbox"), with real Claude Code on the cheapest model:
 *
 *   bun apps/runner/image/durability.ts proof [snapshot]        a repo design: a turn leaves an
 *       uncommitted file, the sandbox sleeps as the API puts it to sleep (warm, then cold), and
 *       if boat does not roll the disk back by itself the checkout, the transcripts and the
 *       runner's marker are put back as they were before that turn; the next turn must see the
 *       file and remember the turn.
 *   bun apps/runner/image/durability.ts double-cold [snapshot]  a Scratch design woken cold twice
 *       in a row, the sequence that rolled boat's disks back: whether it happens, and whether
 *       the runner gets everything back.
 *
 * The fake API holds the runner off after every start until this machine hands back its memory,
 * because the real API is never on the sandbox's disk (trial.ts, `wakeLikeTheApi`). Both need
 * BOAT_API_KEY and ANTHROPIC_API_KEY; `proof` also GITHUB_TEST_REPO, GITHUB_APP_ID,
 * GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH and E2E_PERSON, as e2e.ts's `repo`.
 * What each step saw is printed as JSON and kept in .context/durability/. Every sandbox, the
 * branch and the hidden ref are deleted.
 */
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerSession, ThreadItem } from "../src/api/protocol.ts";
import { destroyOnSignal, provider, sh, until } from "./harness.ts";
import {
  endTrial,
  health,
  message,
  type Recorded,
  record,
  sleepLikeTheApi,
  startTrial,
  type Trial,
  wakeLikeTheApi,
} from "./trial.ts";

const OUT = join(import.meta.dir, "..", "..", "..", ".context", "durability");
const TURN_MS = 5 * 60_000;
/** boat keeps a stopped sandbox's memory for ten minutes; past that a resume boots. */
const COLD_AFTER_MS = 11 * 60_000;
const WARM_AFTER_MS = 60_000;

const [phase, snapshotArg] = process.argv.slice(2);
const snapshot: string =
  snapshotArg ?? JSON.parse(readFileSync(join(import.meta.dir, "current.json"), "utf8")).snapshot;
const boat = provider();
destroyOnSignal();
const report: Record<string, unknown> = { phase, snapshot, at: new Date().toISOString() };
mkdirSync(OUT, { recursive: true });
const name = `${phase}-${Date.now().toString(36)}`;

try {
  if (phase === "proof") await proof();
  else if (phase === "double-cold") await doubleCold();
  else throw new Error("say proof or double-cold");
} finally {
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function proof(): Promise<void> {
  const [owner, repoName] = need("GITHUB_TEST_REPO").split("/") as [string, string];
  const github = await installationToken(repoName);
  const branch = `pz/durability-${Date.now().toString(36)}`;
  let designId: string | null = null;
  try {
    const person = await gh<{ login: string; id: number }>("", `/users/${need("E2E_PERSON")}`);
    const { slug } = await gh<{ slug: string }>(github.jwt, "/app");
    const bot = await gh<{ login: string; id: number }>("", `/users/${slug}%5Bbot%5D`);
    const repository = await gh<{ default_branch: string }>(
      github.token,
      `/repos/${owner}/${repoName}`,
    );
    const noreply = (u: { login: string; id: number }) => ({
      name: u.login,
      email: `${u.id}+${u.login}@users.noreply.github.com`,
    });
    const session: Partial<RunnerSession> = {
      repo: { owner, name: repoName, defaultBranch: repository.default_branch },
      branch,
      author: noreply(person),
      committer: noreply(bot),
    };
    const trial = await startTrial(boat, snapshot, {
      name: "durability-proof",
      label: "image-e2e",
      credential: { ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY") },
      session,
      gitToken: { password: github.token, expiresAt: github.expiresAt },
      hold: true,
    });
    designId = trial.designId;
    report.sandbox = trial.id;
    report.designId = trial.designId;
    try {
      const work = `/home/agent/work/${repoName}`;
      await idle(trial, "the runner to check out the branch");
      const head = (
        await sh(boat, trial.id, `sudo -u agent git -C ${work} rev-parse HEAD`, { quiet: true })
      ).trim();

      // Turn one: something to remember, and a checkpoint of it.
      report.turn1 = await turn(
        trial,
        "Remember the code word apricot for later. Reply with just: noted.",
      );
      const one = await checkpointAfter(trial, 0);
      // The disk as it is before turn two: what a rollback brings back.
      await sh(
        boat,
        trial.id,
        "sudo rm -rf /root/rollback && sudo mkdir -p /root/rollback && sudo cp -a /home/agent/work /home/agent/.claude /home/user/.ponzu /root/rollback/",
        { quiet: true },
      );
      // Turn two: a file written and not committed.
      report.turn2 = await turn(
        trial,
        "In the repository, create the file notes/plan.md holding exactly one line: juniper 42. Do not commit it and do not push. Then reply with just: done.",
      );
      const two = await checkpointAfter(trial, one.turn);
      report.checkpoints = { one, two };
      // GitHub has the work in progress on the hidden ref, and the branch is untouched.
      const wip = await gh<{ object: { sha: string } }>(
        github.token,
        `/repos/${owner}/${repoName}/git/ref/ponzu/wip/${trial.designId}`,
      );
      const plan = await gh<{ content: string }>(
        github.token,
        `/repos/${owner}/${repoName}/contents/notes/plan.md?ref=${wip.object.sha}`,
      );
      const branchOnGithub = await gh(
        github.token,
        `/repos/${owner}/${repoName}/branches/${encodeURIComponent(branch)}`,
      ).then(
        () => true,
        () => false,
      );
      report.hiddenRef = {
        commit: wip.object.sha,
        matchesCheckpoint: wip.object.sha === two.wipCommit,
        planOnRef: Buffer.from(plan.content, "base64").toString("utf8").trim(),
        branchPushed: branchOnGithub,
      };

      // A warm sleep and wake, as the API does them.
      const warmSleep = await sleepLikeTheApi(trial);
      await Bun.sleep(WARM_AFTER_MS);
      const warmWake = await wake(trial, warmSleep.memory);
      report.warm = { sleep: without(warmSleep, "memory"), wake: warmWake };
      await idle(trial, "the runner after the warm wake");

      // A cold one.
      const coldSleep = await sleepLikeTheApi(trial);
      console.log(`cold: asleep; resuming in ${COLD_AFTER_MS / 1000} s`);
      await Bun.sleep(COLD_AFTER_MS);
      const coldWake = await wake(trial, coldSleep.memory);
      await idle(trial, "the runner after the cold wake");
      const afterCold = await record(trial);
      const boatRolledBack = afterCold.restored.some((r) => r.kind === "rollback");
      report.cold = {
        sleep: without(coldSleep, "memory"),
        wake: coldWake,
        boatRolledBack,
        restored: afterCold.restored,
      };

      // boat did not do it this time: do it deterministically, as it was seen to.
      if (!boatRolledBack) {
        await sh(
          boat,
          trial.id,
          [
            "sudo systemctl stop ponzu-runner",
            "sudo rm -rf /home/agent/work /home/agent/.claude /home/user/.ponzu",
            "sudo cp -a /root/rollback/work /root/rollback/.claude /home/agent/",
            "sudo cp -a /root/rollback/.ponzu /home/user/",
            "sync",
            "sudo systemctl start ponzu-runner",
          ].join(" && "),
          { quiet: true },
        );
        await until("the runner's /health", () => health(trial.runner), 120_000, 200);
        await idle(trial, "the runner after the simulated rollback");
      }
      const recovered = await record(trial);
      report.rollback = {
        simulated: !boatRolledBack,
        restored: recovered.restored,
        events: await journal(
          trial,
          "sandbox_rollback|sandbox_rebuilt|work in progress|checkpoint",
        ),
      };
      if (!recovered.restored.some((r) => r.kind === "rollback"))
        throw new Error("the runner did not see its disk was behind the checkpoint");

      // The checkout has the file back, uncommitted, on the same HEAD.
      const disk = await sh(
        boat,
        trial.id,
        `sudo -u agent cat ${work}/notes/plan.md; sudo -u agent git -C ${work} rev-parse HEAD; sudo -u agent git -C ${work} status --porcelain`,
        { quiet: true },
      );
      const [planLine = "", headNow = "", ...status] = disk.trim().split("\n");
      report.checkout = { plan: planLine, sameHead: headNow === head, status };
      if (planLine.trim() !== "juniper 42") throw new Error(`notes/plan.md is "${planLine}"`);

      // And the session remembers both turns.
      const asked = await turn(
        trial,
        "Without using any tools, answer in one line: what code word did I ask you to remember, and what single line did you write into notes/plan.md?",
      );
      report.turn3 = asked;
      const reply = String(asked.reply).toLowerCase();
      if (!reply.includes("apricot") || !reply.includes("juniper"))
        throw new Error(`the session forgot: ${asked.reply}`);
      report.ok = true;
    } catch (err) {
      report.journal = await journal(trial, ".").catch((e) => String(e));
      throw err;
    } finally {
      await endTrial(trial);
    }
  } finally {
    if (designId)
      await gh(
        github.token,
        `/repos/${owner}/${repoName}/git/refs/ponzu/wip/${designId}`,
        "DELETE",
      ).catch((err) => console.log(`could not delete the hidden ref: ${err}`));
    await gh(github.token, `/repos/${owner}/${repoName}/git/refs/heads/${branch}`, "DELETE").catch(
      () => {},
    );
    await gh(github.token, "/installation/token", "DELETE").catch(() => {});
  }
}

async function doubleCold(): Promise<void> {
  const trial = await startTrial(boat, snapshot, {
    name: "durability-double-cold",
    label: "image-e2e",
    credential: { ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY") },
    hold: true,
  });
  report.sandbox = trial.id;
  report.designId = trial.designId;
  const notes = "/home/agent/work/scratch/notes.txt";
  try {
    await idle(trial, "the runner to start");
    report.turn1 = await turn(
      trial,
      "Remember the word apricot. Write it as the only line of notes.txt in your working folder. Reply with just: ok.",
    );
    const one = await checkpointAfter(trial, 0);
    const wakes: unknown[] = [];
    report.wakes = wakes;

    // First cold stop and start.
    wakes.push(await coldCycle(trial, "first"));
    report.turn2 = await turn(
      trial,
      "Also remember the word juniper, and add it as a second line of notes.txt. Reply with just: ok.",
    );
    const two = await checkpointAfter(trial, one.turn);
    report.checkpoints = { one, two };

    // Second cold stop and start: where boat's disk went back to the first.
    wakes.push(await coldCycle(trial, "second"));
    const file = (await sh(boat, trial.id, `sudo -u agent cat ${notes}`, { quiet: true })).trim();
    const asked = await turn(
      trial,
      "Without using any tools, answer in one line: which two words did I ask you to remember?",
    );
    report.turn3 = asked;
    const reply = String(asked.reply).toLowerCase();
    report.after = {
      notes: file,
      remembersBoth: reply.includes("apricot") && reply.includes("juniper"),
      fileHasBoth: file.includes("apricot") && file.includes("juniper"),
    };
    if (!(report.after as { remembersBoth: boolean }).remembersBoth)
      throw new Error(`the session forgot: ${asked.reply}`);
    if (!(report.after as { fileHasBoth: boolean }).fileHasBoth)
      throw new Error(`notes.txt lost a line: ${file}`);
    report.ok = true;
  } catch (err) {
    report.journal = await journal(trial, ".").catch((e) => String(e));
    throw err;
  } finally {
    await endTrial(trial);
  }
}

/**
 * Sleeps as the API does, waits out the warm window, wakes cold, and says what came back: the
 * runner's own verdict, a flushed and an unflushed probe file, and the fake API's own state file.
 */
async function coldCycle(trial: Trial, which: string) {
  const nonce = Date.now().toString(36);
  await sh(
    boat,
    trial.id,
    `echo ${nonce} > ~/.ponzu-probe-synced && sync ~/.ponzu-probe-synced && echo ${nonce} > ~/.ponzu-probe-unsynced`,
    { quiet: true },
  );
  const before = await record(trial);
  const slept = await sleepLikeTheApi(trial);
  console.log(`${which} cold: asleep; resuming in ${COLD_AFTER_MS / 1000} s`);
  await Bun.sleep(COLD_AFTER_MS);
  const woke = await wake(trial, slept.memory);
  const probes = await sh(
    boat,
    trial.id,
    'printf "%s\\n%s\\n%s\\n" "$(cat ~/.ponzu-probe-synced)" "$(cat ~/.ponzu-probe-unsynced 2>/dev/null)" "$(cat /proc/sys/kernel/random/boot_id)"',
    { quiet: true },
  );
  const [synced = "", unsynced = "", boot = ""] = probes.split("\n").map((l) => l.trim());
  await idle(trial, `the runner after the ${which} cold wake`);
  const after = await record(trial);
  const savedTurn = (slept.memory.saved as { turn: number } | null)?.turn ?? null;
  const result = {
    which,
    coldStart: woke.coldStart,
    boot,
    sleep: without(slept, "memory"),
    healthSeconds: woke.healthSeconds,
    disk: {
      syncedProbeKept: synced === nonce,
      unsyncedProbeKept: unsynced === nonce,
      // The fake flushes its own file before every answer: older than what this machine kept
      // means the disk went back.
      fakeFileSavedTurn: woke.fakeFileSavedTurn,
      apiSavedTurn: savedTurn,
      fakeFileWentBack: woke.fakeFileSavedTurn !== savedTurn,
      fakeFileWrites: woke.fakeFileWrites,
      fakeWritesBeforeStop: before.kept.writes,
    },
    runner: after.restored.slice(before.restored.length),
    events: await journal(trial, "sandbox_rollback|sandbox_rebuilt|this disk|work in progress"),
  };
  console.log(JSON.stringify(result));
  return result;
}

/* Turns, as the fake API saw them. */

function since(from: Recorded, at: number): ThreadItem[] {
  return from.items.filter((i) => Date.parse(i.at) > at);
}

function assistantText(r: Recorded, at: number): string | null {
  const item = since(r, at).find(
    (i) => i.kind === "assistant" && (i.payload as { text: string }).text.trim(),
  );
  return item ? (item.payload as { text: string }).text : null;
}

async function idle(trial: Trial, what: string): Promise<Recorded> {
  return until(
    what,
    async () => {
      const r = await record(trial);
      const up = r.items.some(
        (i) =>
          i.kind === "notice" &&
          ["started", "resumed"].includes((i.payload as { type: string }).type),
      );
      return up && !r.held && r.states.at(-1)?.state === "idle" ? r : null;
    },
    180_000,
    500,
  );
}

async function turn(trial: Trial, text: string) {
  const at = (await record(trial)).now;
  const asked = await message(trial, text);
  const done = await until(
    "the turn to end",
    async () => {
      const r = await record(trial);
      const states = r.states.filter((s) => s.at > at).map((s) => s.state);
      const ended =
        r.delivered.includes(asked.id) &&
        states.includes("working") &&
        states.at(-1) === "idle" &&
        assistantText(r, at) !== null &&
        !r.items.some((i) => i.streaming);
      return ended ? r : null;
    },
    TURN_MS,
    500,
  );
  return {
    reply: (assistantText(done, at) ?? "").slice(0, 300),
    tools: since(done, at)
      .filter((i) => i.kind === "tool")
      .map((i) => (i.payload as { label: string }).label),
  };
}

/** The checkpoint the turn just ended saved: one past `after`. */
async function checkpointAfter(trial: Trial, after: number) {
  const r = await until(
    "the turn's checkpoint",
    async () => {
      const got = await record(trial);
      return got.saved && got.saved.turn > after ? got : null;
    },
    60_000,
    500,
  );
  return r.saved!;
}

async function journal(trial: Trial, pattern: string): Promise<string[]> {
  const out = await sh(
    boat,
    trial.id,
    `sudo journalctl -u ponzu-runner -u ponzu-fake-api -b 0 --no-pager -o short-iso | grep -E '${pattern}' | grep -v -e pam_unix -e 'sudo\\[' | tail -40`,
    { quiet: true },
  ).catch(() => "");
  return out.trim().split("\n").filter(Boolean);
}

/**
 * `wakeLikeTheApi`, and when the fake API's address does not answer, what the sandbox says of
 * its two units from the inside, kept in the report; then once more through the addresses.
 */
async function wake(trial: Trial, memory: Parameters<typeof wakeLikeTheApi>[1]) {
  try {
    return await wakeLikeTheApi(trial, memory);
  } catch (err) {
    const seen = await sh(
      boat,
      trial.id,
      "systemctl is-active ponzu-fake-api ponzu-runner; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8790/control/record; curl -s http://127.0.0.1:4600/health; echo; cat /proc/sys/kernel/random/boot_id",
      { quiet: true },
    ).catch((e) => String(e));
    report.wakeFailure = { error: String(err), seen: seen.trim().split("\n") };
    // Through the addresses, once more, now that the sandbox has had longer.
    return await wakeLikeTheApi(trial, memory);
  }
}

function without<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const { [key]: _, ...rest } = o;
  return rest;
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

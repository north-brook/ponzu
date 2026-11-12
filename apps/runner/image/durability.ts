#!/usr/bin/env bun
/**
 * What a canvas keeps across a sleep and across losing its sandbox altogether, for real, in a
 * Vercel Sandbox made from the image (docs/cloud.md, "Saving the sandbox"), with real Claude
 * Code on Haiku:
 *
 *   bun apps/runner/image/durability.ts [image]     current.json's image by default
 *
 * A repo canvas on GITHUB_TEST_REPO. Turn one gives Claude something to remember; turn two
 * writes a file and does not commit it. Each turn's checkpoint goes to the fake API (R2's
 * stand-in), with the work in progress and nothing of it on GitHub. Then:
 *   1. a sleep as the API's (ponzu-stop, then stop) and a wake (up, ponzu-start): the snapshot
 *      brings the disk back as it was, and the runner restores nothing;
 *   2. the sandbox is removed, as an image change, Vercel's 14-day removal or an expired
 *      snapshot leave it; up() makes a new one on an empty disk, the fake API starts from the
 *      memory this machine kept (the real API is never on the sandbox's disk), and the runner
 *      rebuilds from the checkpoint and git: the file is back,
 *      uncommitted, on the same HEAD, the session's folder is back, and turn three remembers
 *      both turns.
 * Vercel keeps one snapshot ({count: 1, deleteEvicted: true}), so no rollback is manufactured.
 *
 * Needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, ANTHROPIC_API_KEY, GITHUB_TEST_REPO,
 * GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH (E2E_PERSON as
 * e2e.ts's repo). Every line is kept in .context/image/durability.jsonl. The sandbox
 * (pz-test-durability-*) and the branch are deleted, on Ctrl-C too.
 */
import { IMAGE_COMMANDS } from "../src/api/protocol.ts";
import { readCurrent } from "./image.ts";
import {
  afterTurn,
  assistantText,
  type Box,
  buildRunnerBundle,
  control,
  FAKE_STATE,
  gh,
  idle,
  installationToken,
  installFakeApi,
  mark,
  message,
  need,
  newer,
  newStart,
  note,
  record,
  removeAll,
  removeOnSignal,
  repoSession,
  reUp,
  runnerLog,
  STOP_COMMAND_MS,
  type Start,
  sandboxes,
  secs,
  sh,
  sleepLikeTheApi,
  startFakeApi,
  startRunner,
  testSpec,
  until,
  upBox,
} from "./live.ts";

const image = process.argv[2] ?? readCurrent().image;
const say = (event: string, data: Record<string, unknown> = {}) => note("durability", event, data);

removeOnSignal();
const bundle = buildRunnerBundle();
const [, repoName] = need("GITHUB_TEST_REPO").split("/") as [string, string];
const github = await installationToken(repoName);
const gitToken = { password: github.token, expiresAt: github.expiresAt };
const branch = `pz/durability-${Date.now().toString(36)}`;
const { owner, name, session } = await repoSession(github, branch);
let box: Box | null = null;
try {
  await proof();
  say("passed", { image });
} catch (err) {
  say("failed", { error: String(err).slice(0, 3000) });
  if (box) say("log", { log: await runnerLog(box) });
  process.exitCode = 1;
} finally {
  await removeAll();
  await gh(github.token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, "DELETE").catch(
    () => {},
  );
  await gh(github.token, "/installation/token", "DELETE").catch(() => {});
  const left = await sandboxes().list("pz-test-durability-");
  say("cleanup", { left: left.map((s) => `${s.name}:${s.status}`) });
}

async function proof(): Promise<void> {
  const start = newStart(bundle, need("ANTHROPIC_API_KEY"));
  box = await upBox("durability", testSpec(image));
  const b = box;
  say("up", { name: b.name, fresh: b.up.fresh });
  await installFakeApi(b, bundle);
  await startFakeApi(b, start);
  await control(b, start, "PUT", "session", session);
  await control(b, start, "PUT", "git-token", gitToken);
  await startRunner(b, start);
  await idle(b, start, "the runner to check out the branch");
  const work = `/home/agent/work/${name}`;
  const head = await agentSh(b, `git -C ${work} rev-parse HEAD`);

  // Turn one: something to remember, and its checkpoint.
  const turn1 = await turn(
    b,
    start,
    "Remember the code word apricot for later. Reply with just: noted.",
  );
  say("turn1", turn1);
  const one = await checkpointAfter(b, start, 0);
  // A folder beside the transcript, as Claude Code makes for subagents: it must come back too.
  const sessionId = (await record(b, start)).session.claudeSessionId;
  if (!sessionId) throw new Error("no Claude session after turn one");
  await sh(
    b,
    `sudo -u agent sh -c 'f=$(ls /home/agent/.claude/projects/*/${sessionId}.jsonl | head -1) && d="\${f%.jsonl}" && mkdir -p "$d/subagents" && echo "{}" > "$d/subagents/agent-probe.jsonl"'`,
  );
  const probe = `/home/agent/.claude/projects/*/${sessionId}/subagents/agent-probe.jsonl`;

  // Turn two: a file written and not committed.
  const turn2 = await turn(
    b,
    start,
    "In the repository, create the file notes/plan.md holding exactly one line: juniper 42. Do not commit it and do not push. Then reply with just: done.",
  );
  say("turn2", turn2);
  const two = await checkpointAfter(b, start, one.turn);
  const onGithub = (path: string) =>
    gh(github.token, `/repos/${owner}/${name}${path}`).then(
      () => true,
      () => false,
    );
  const wip = {
    commit: two.wipCommit,
    archived: two.workspace,
    wipRefOnGithub: await onGithub(`/git/ref/ponzu/wip/${start.canvasId}`),
    branchOnGithub: await onGithub(`/branches/${encodeURIComponent(branch)}`),
  };
  say("checkpoints", { one, two, wip });
  if (!two.wipCommit || !two.workspace || wip.wipRefOnGithub)
    throw new Error("the work in progress was not kept with the checkpoint alone");

  // 1. A sleep and a wake, as the API does them: the snapshot is the disk.
  const slept = await sleepLikeTheApi(b);
  const w0 = performance.now();
  const up = await reUp(b);
  if (up.fresh || up.wasRunning) throw new Error(`the wake: ${JSON.stringify(up)}`);
  await startFakeApi(b, start);
  // The fake never writes the git token down, where the real API always has one to mint.
  await control(b, start, "PUT", "git-token", gitToken);
  await startRunner(b, start);
  const woke = await idle(b, start, "the runner after the wake");
  say("wake", { ...slept, idleSeconds: secs(performance.now() - w0), restored: woke.restored });
  if (woke.restored.length) throw new Error(`a wake restored: ${JSON.stringify(woke.restored)}`);
  if ((await agentSh(b, `cat ${work}/notes/plan.md`)) !== "juniper 42")
    throw new Error("the wake lost notes/plan.md");

  // 2. The sandbox goes: what the API keeps (the fake's memory, taken after the runner's own
  // shutdown checkpoint) stays on this machine.
  const stopped = await sandboxes().exec(b.at, {
    cmd: IMAGE_COMMANDS.stop,
    sudo: true,
    timeoutMs: STOP_COMMAND_MS,
  });
  if (stopped.exitCode !== 0) throw new Error(`ponzu-stop exited ${stopped.exitCode}`);
  const memory = await control<Record<string, unknown>>(b, start, "GET", "memory");
  await sandboxes().stop(b.at);
  await sandboxes().remove(b.name);
  const gone = await sandboxes().status(b.name);
  if (gone) throw new Error(`still there after remove: ${gone.status}`);
  const r0 = performance.now();
  const fresh = await reUp(b);
  say("recreate", { upSeconds: secs(performance.now() - r0), fresh: fresh.fresh });
  if (!fresh.fresh) throw new Error("up() after a remove did not start on an empty disk");
  await installFakeApi(b, bundle);
  // What the API remembers, feed position included, is there before the runner asks: the fake
  // starts from it. A git token is never in it; the API mints one.
  await sandboxes().writeFile(b.at, FAKE_STATE, JSON.stringify(memory));
  await startFakeApi(b, start);
  await control(b, start, "PUT", "git-token", gitToken);
  await startRunner(b, start);
  const rebuilt = await idle(b, start, "the runner after the rebuild", 300_000);
  say("rebuild", {
    seconds: secs(performance.now() - r0),
    restored: rebuilt.restored,
    bundlesServed: rebuilt.bundles,
  });
  if (!rebuilt.restored.some((r) => r.kind === "rebuilt"))
    throw new Error(`the runner did not rebuild: ${JSON.stringify(rebuilt.restored)}`);

  // The checkout has the file back, uncommitted, on the same HEAD; the session's folder is back.
  const plan = await agentSh(b, `cat ${work}/notes/plan.md`);
  const headNow = await agentSh(b, `git -C ${work} rev-parse HEAD`);
  const status = await agentSh(b, `git -C ${work} status --porcelain`);
  const folder = (await sh(b, `sudo sh -c 'ls ${probe}' || true`)).stdout.trim();
  say("checkout", { plan, sameHead: headNow === head, status, sessionFolderRestored: !!folder });
  if (plan !== "juniper 42") throw new Error(`notes/plan.md is "${plan}"`);
  if (headNow !== head) throw new Error(`HEAD moved: ${head} to ${headNow}`);
  if (!folder) throw new Error("the session's folder did not come back");

  // And the session remembers both turns.
  const turn3 = await turn(
    b,
    start,
    "Without using any tools, answer in one line: what code word did I ask you to remember, and what single line did you write into notes/plan.md?",
  );
  say("turn3", turn3);
  const reply = turn3.reply.toLowerCase();
  if (!reply.includes("apricot") || !reply.includes("juniper"))
    throw new Error(`the session forgot: ${turn3.reply}`);
}

async function agentSh(b: Box, command: string): Promise<string> {
  return (await sh(b, `sudo -u agent sh -c ${JSON.stringify(command)}`)).stdout.trim();
}

async function turn(b: Box, start: Start, text: string) {
  const from = mark(await record(b, start));
  const asked = await message(b, start, text);
  const done = await afterTurn(b, start, asked.id, from);
  return {
    reply: (assistantText(done, from) ?? "").slice(0, 300),
    tools: newer(done, from)
      .filter((i) => i.kind === "tool")
      .map((i) => (i.payload as { label: string }).label),
  };
}

/** The checkpoint the turn just ended saved: one past `after`. */
async function checkpointAfter(b: Box, start: Start, after: number) {
  const r = await until(
    "the turn's checkpoint",
    async () => {
      const got = await record(b, start);
      return got.saved && got.saved.turn > after ? got : null;
    },
    60_000,
    500,
  );
  return r.saved!;
}

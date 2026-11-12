#!/usr/bin/env bun
/**
 * The real runner and real Claude turns (Haiku, the development key) in Vercel Sandboxes made
 * from the image, through @ponzu/sandbox as the API drives it, against the runner's fake API in
 * the same sandbox (sandbox/fake-api.ts), timed from here:
 *
 *   bun apps/runner/image/e2e.ts [scratch|repo|all] [image]     all, and current.json's image
 *
 * scratch: up (a create), ponzu-start fetches the runner bundle from the fake API and starts
 *   the runner, a turn that draws; the public port without its bearer; then twice: a sleep as
 *   the API's (ponzu-stop, then stop), up again (a resume, the same disk), ponzu-start (the
 *   bundle is already on the disk), a turn in the same Claude session. Every wake is timed.
 * repo: a canvas on GITHUB_TEST_REPO: the runner checks out a new branch, Claude commits a file
 *   and pushes it. Needs GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH;
 *   E2E_PERSON (a GitHub login) authors the commit, else the App's bot does. The branch and the
 *   one-hour token are deleted after.
 *
 * Needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID and ANTHROPIC_API_KEY. Every line is kept
 * in .context/image/e2e.jsonl. Every sandbox (pz-test-e2e-*) is removed, on Ctrl-C too.
 */
import { RUNNER_PORT } from "../src/api/protocol.ts";
import { readCurrent } from "./image.ts";
import {
  afterTurn,
  assistantText,
  type Box,
  buildRunnerBundle,
  control,
  FAKE_API_PORT,
  gh,
  health,
  idle,
  installationToken,
  installFakeApi,
  mark,
  message,
  need,
  newer,
  newStart,
  note,
  type Recorded,
  record,
  removeAll,
  removeOnSignal,
  repoSession,
  reUp,
  runnerLog,
  type Start,
  sandboxes,
  secs,
  sh,
  sleepLikeTheApi,
  startFakeApi,
  startRunner,
  statesSince,
  testSpec,
  until,
  upBox,
} from "./live.ts";

const [phase = "all", imageArg] = process.argv.slice(2);
const image = imageArg ?? readCurrent().image;
const PROMPT =
  "Make one small artboard named Hello, 320 by 200, with a single centered heading that reads 'Hello from Ponzu'.";
const say = (event: string, data: Record<string, unknown> = {}) =>
  note("e2e", event, { phase, ...data });

removeOnSignal();
const bundle = buildRunnerBundle();
say("bundle", { sha256: bundle.sha256, requires: bundle.requires, bytes: bundle.tgz.length });
try {
  if (phase === "scratch" || phase === "all") await scratch();
  if (phase === "repo" || phase === "all") await repo();
  if (!["scratch", "repo", "all"].includes(phase)) throw new Error("say scratch, repo or all");
  say("passed", { image });
} catch (err) {
  say("failed", { error: String(err).slice(0, 3000) });
  process.exitCode = 1;
} finally {
  await removeAll();
  const left = await sandboxes().list("pz-test-e2e-");
  say("cleanup", { left: left.map((s) => `${s.name}:${s.status}`) });
}

async function scratch(): Promise<void> {
  const start = newStart(bundle, need("ANTHROPIC_API_KEY"));
  const t0 = performance.now();
  const box = await upBox("e2e", testSpec(image));
  say("up", {
    name: box.name,
    upSeconds: secs(performance.now() - t0),
    fresh: box.up.fresh,
    recreated: box.up.recreated,
    wasRunning: box.up.wasRunning,
    image: box.up.image,
  });
  try {
    await installFakeApi(box, bundle);
    const first = await bootAndTurn(box, start, "create", t0, PROMPT);
    if (first.bundles !== 1)
      throw new Error(`the create fetched the bundle ${first.bundles} times`);
    await publicPorts(box, start);
    const session = (await record(box, start)).session.claudeSessionId;

    for (const n of [1, 2]) {
      const slept = await sleepLikeTheApi(box);
      say("sleep", { n, ...slept });
      if (slept.statusAfter !== "stopped") throw new Error(`after the stop: ${slept.statusAfter}`);
      // A status read never wakes it.
      await Bun.sleep(5_000);
      const still = await sandboxes().status(box.name);
      if (still?.status !== "stopped") throw new Error(`5 s after a status read: ${still?.status}`);
      const w0 = performance.now();
      const up = await reUp(box);
      say("wake.up", {
        n,
        upSeconds: secs(performance.now() - w0),
        fresh: up.fresh,
        recreated: up.recreated,
        wasRunning: up.wasRunning,
      });
      if (up.fresh || up.recreated || up.wasRunning)
        throw new Error(`a wake must resume the same disk: ${JSON.stringify(up)}`);
      const turn = await bootAndTurn(
        box,
        start,
        `wake${n}`,
        w0,
        `Replace the Hello artboard's heading with 'Hello again, wake ${n}'. Nothing else.`,
      );
      if (turn.bundles !== 0) throw new Error(`wake ${n} fetched the bundle again`);
      if (turn.session !== session)
        throw new Error(`wake ${n} is a new Claude session: ${turn.session} after ${session}`);
    }
  } catch (err) {
    say("scratch.log", { log: await runnerLog(box) });
    throw err;
  }
}

/**
 * As the API's wake: the fake API up (it is the API, always there), the message that woke the
 * canvas in the feed, then ponzu-start. Times the runner to /health, its first claim, the first
 * thread item, the first artboard change and both previews, from `t0` (the up() call).
 */
async function bootAndTurn(box: Box, start: Start, label: string, t0: number, text: string) {
  await startFakeApi(box, start);
  const fakeUp = secs(performance.now() - t0);
  const before = await record(box, start);
  const asked = await message(box, start, text);
  const startMs = await startRunner(box, start);
  const marks: Record<string, number> = {};
  const at = (k: string) => {
    if (!(k in marks)) marks[k] = secs(performance.now() - t0);
  };
  const from = mark(before);
  const boardsBefore = before.doc.doc.pages.flatMap((p) => p.artboards).length;
  const done = await until(
    `the ${label} turn`,
    async () => {
      if (!("health" in marks) && (await health(box, start).catch(() => null))) at("health");
      const r = await record(box, start);
      const fresh = newer(r, from);
      if (r.claims.some((c) => c > before.now)) at("firstClaim");
      if (fresh.some((i) => i.kind === "assistant" || i.kind === "tool")) at("firstItem");
      const boards = r.doc.doc.pages.flatMap((p) => p.artboards).length;
      if (boards > boardsBefore || (label !== "create" && r.doc.seq > before.doc.seq))
        at("firstArtboard");
      const states = statesSince(r, from);
      const finished =
        r.delivered.includes(asked.id) &&
        states.includes("working") &&
        states.at(-1) === "idle" &&
        assistantText(r, from) !== null &&
        !r.items.some((i) => i.streaming);
      return finished ? r : null;
    },
    6 * 60_000,
    150,
  );
  at("turnDone");
  const previews = await afterTurn(box, start, asked.id, from, {
    previews: before.uploads.filter((u) => u.purpose === "preview").length + 2,
    ms: 60_000,
  }).catch(() => null);
  if (previews) at("bothPreviews");
  const r: Recorded = previews ?? done;
  const boards = r.doc.doc.pages.flatMap((p) => p.artboards.map((a) => a.name));
  const notices = newer(r, from)
    .filter((i) => i.kind === "notice")
    .map((i) => (i.payload as { type: string }).type);
  say("turn", {
    label,
    fromUpSeconds: marks,
    fakeUpSeconds: fakeUp,
    startCommandMs: Math.round(startMs),
    artboards: boards,
    previews: r.uploads.map((u) => u.name),
    notices,
    tools: newer(r, from)
      .filter((i) => i.kind === "tool")
      .map((i) => (i.payload as { label: string }).label),
    reply: (assistantText(r, from) ?? "").slice(0, 200),
    usage: r.usage.length,
    bundlesServed: r.bundles,
  });
  if (!boards.includes("Hello")) throw new Error(`no Hello artboard after ${label}: ${boards}`);
  if (!previews) throw new Error(`no light and dark previews after ${label}`);
  return { bundles: r.bundles, session: r.session.claudeSessionId, marks };
}

/** The public addresses answer anyone with the URL: the bearers are what stand in the way. */
async function publicPorts(box: Box, start: Start) {
  const status = async (url: string, init: RequestInit = {}) => {
    for (let i = 0; ; i++) {
      const r = await fetch(url, { redirect: "manual", ...init });
      if (r.status !== 502 || i > 10) return r.status;
      await Bun.sleep(150);
    }
  };
  const runner = box.urls[RUNNER_PORT];
  const result = {
    healthNoBearer: await status(`${runner}/health`),
    pokeNoBearer: await status(`${runner}/poke`, { method: "POST" }),
    healthRunnerTokenAsBearer: await status(`${runner}/health`, {
      headers: { authorization: `Bearer ${start.runnerToken}` },
    }),
    fakeControlNoBearer: await status(`${box.urls[FAKE_API_PORT]}/control/record`),
    healthWithBearer: await status(`${runner}/health`, {
      headers: { authorization: `Bearer ${start.portToken}` },
    }),
  };
  say("publicPorts", result);
  if (
    result.healthNoBearer !== 401 ||
    result.pokeNoBearer !== 401 ||
    result.healthRunnerTokenAsBearer !== 401 ||
    result.fakeControlNoBearer !== 401 ||
    result.healthWithBearer !== 200
  )
    throw new Error(`the port's bearer: ${JSON.stringify(result)}`);
}

async function repo(): Promise<void> {
  const [, repoName] = need("GITHUB_TEST_REPO").split("/") as [string, string];
  const github = await installationToken(repoName);
  const branch = `pz/image-e2e-${Date.now().toString(36)}`;
  const { owner, name, session } = await repoSession(github, branch);
  try {
    const start = newStart(bundle, need("ANTHROPIC_API_KEY"));
    const t0 = performance.now();
    const box = await upBox("e2e", testSpec(image));
    try {
      await installFakeApi(box, bundle);
      await startFakeApi(box, start);
      await control(box, start, "PUT", "session", session);
      // Over the address's TLS, into the fake's memory: never a command, a file or a log.
      await control(box, start, "PUT", "git-token", {
        password: github.token,
        expiresAt: github.expiresAt,
      });
      await startRunner(box, start);
      const ready = await idle(box, start, "the runner to check out the branch");
      say("repo.ready", { seconds: secs(performance.now() - t0) });
      const work = `/home/agent/work/${name}`;
      // The checkout is the agent's, on the canvas's branch, and git asks only the runner.
      const checkout = (
        await sh(
          box,
          `stat -c %U ${work}; sudo -u agent git -C ${work} branch --show-current; sudo -u agent git config --global --get-all credential.https://github.com.helper | tail -1`,
        )
      ).stdout
        .trim()
        .split("\n");
      say("repo.checkout", { checkout });
      if (checkout[0] !== "agent" || checkout[1] !== branch)
        throw new Error(`the checkout: ${checkout}`);
      const from = mark(ready);
      const asked = await message(
        box,
        start,
        "In the repository, add a file named ponzu-e2e.txt holding one line: hello from a Ponzu sandbox. Commit it with the message 'chore: check the sandbox image' and push the branch. Do not draw anything.",
      );
      const turn = await afterTurn(box, start, asked.id, from);
      say("repo.turn", {
        reply: (assistantText(turn, from) ?? "").slice(0, 200),
        tools: newer(turn, from)
          .filter((i) => i.kind === "tool")
          .map((i) => (i.payload as { label: string }).label),
      });
      const pushed = await until(
        "the branch on GitHub",
        () =>
          gh<{ commit: { sha: string } }>(
            github.token,
            `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
          ),
        60_000,
        2_000,
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
      say("repo.commit", {
        sha: pushed.commit.sha,
        message: commit.commit.message,
        files: commit.files.map((f) => f.filename),
        ...people,
      });
      const want = { author: session.author, committer: session.committer };
      if (JSON.stringify(people) !== JSON.stringify(want))
        throw new Error(`want ${JSON.stringify(want)}, got ${JSON.stringify(people)}`);
      if (!commit.files.some((f) => f.filename === "ponzu-e2e.txt"))
        throw new Error("the commit does not hold ponzu-e2e.txt");
    } catch (err) {
      say("repo.log", { log: await runnerLog(box) });
      throw err;
    }
  } finally {
    await gh(github.token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, "DELETE").catch(
      (err) => say("repo.branchNotDeleted", { error: String(err) }),
    );
    await gh(github.token, "/installation/token", "DELETE").catch(() => {});
  }
}

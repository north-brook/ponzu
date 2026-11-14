// The real GitHub, through this module's own functions: a branch pushed with git and a one-hour
// installation token, its pull request opened as the developer with their own GitHub token, read
// as the App until GitHub knows whether it can merge, marked ready, brought up to date with its
// base and merged as the developer, the canvas settled, and the branches deleted. It merges into
// a branch of its own made from the default branch, which the database calls the repo's default
// branch while it runs, so the repository's own is left as it was; the closed pull request
// stays, as GitHub cannot delete one.
//
// Then the agent's side of the same (`agent.ts`), through the runner's routes over `createApp`
// in-process with a runner token minted for the canvas: a person's message handed to the runner
// and acknowledged, so the turn is theirs; open, read, ready, update the branch, auto-merge and
// merge, each said in the thread as the agent's line naming the developer; and a turn a review
// began, whose merge is refused before GitHub hears of it. The same story runs against the fake
// GitHub in every `bun test` ("the agent's pull request, against the fake GitHub"), so its body
// is proven there before anyone runs it for real.
//
// Not covered here: a base the repo's rules protect. Making one takes the repo's administration
// permission, which neither the App nor a token acting through it has.
//
// The real ones are skipped unless GITHUB_TEST_REPO (owner/name, where the App is installed), the
// App's GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY_PATH,
// DATABASE_URL (the Neon `dev` branch, with this branch's migrations), PONZU_VAULT_KEY and
// PONZU_SESSION_FILE are set. GITHUB_APP_SLUG, if set, marks the App's own bot in what is read.
// Never run in CI.
//
// PONZU_SESSION_FILE is the check account's dev session, `~/.ponzu-check-dev-session.json`, and
// never anyone else's: the developer these act as is whoever it names. It only says who that is
// (its `user.id`); its tokens are not used. Their GitHub token is the one the API keeps,
// refreshed by `githubUserToken` as the API would.
//
// Each run touches only branches it made, under a name of its own (`pz-live-base-<tag>` and
// `pz/live-<tag>`, `pz-agent-base-<tag>` and `pz/agent-<tag>`), and deletes them, closes what it
// left open and deletes its canvas row even when an assertion fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDoc } from "@ponzu/core";
import {
  appendEvent,
  claimEvents,
  countAgentPullRequestActions,
  createCanvas,
  createDb,
  createRunnerToken,
  type Db,
  deleteCanvas,
  type FeedEvent,
  getCanvas,
  getPullRequestContext,
  getUser,
  listThreadItems,
  markEventsDelivered,
  newId,
  repos,
  takeRunnerLease,
  type User,
} from "@ponzu/db";
import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import { type Clock, systemClock } from "@ponzu/sandbox";
import { noAnalytics } from "../analytics/analytics.ts";
import { DocCache } from "../canvases/doc-cache.ts";
import { createApp } from "../create-app.ts";
import type { Fetch } from "../deps/fetch.ts";
import { createGithub, type Github } from "../deps/github.ts";
import { type Config, type Deps, randomIds } from "../deps/index.ts";
import { noMail } from "../deps/mail.ts";
import { noPush } from "../deps/push.ts";
import { noRateLimit } from "../deps/rate-limit.ts";
import type { ObjectStorage } from "../deps/storage.ts";
import { EMAIL_CONFIG_UNSET } from "../email/kinds.ts";
import type { SandboxConfig } from "../env.ts";
import { FEATURES_OFF } from "../features.ts";
import { createLogger } from "../http/log.ts";
import type { JobDeps } from "../jobs/run.ts";
import { GitTokens } from "../runner/git-credential.ts";
import { workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { createVault } from "../vault/vault.ts";
import { actOnPullRequest } from "./actions.ts";
import { openPullRequest, savePullRequestSummary } from "./open.ts";
import { readPullRequest, refreshPullRequest, targetOf } from "./sync.ts";

const env = process.env;
const configured =
  env.GITHUB_TEST_REPO &&
  env.GITHUB_APP_CLIENT_ID &&
  env.GITHUB_APP_CLIENT_SECRET &&
  env.GITHUB_APP_PRIVATE_KEY_PATH &&
  env.DATABASE_URL &&
  env.PONZU_VAULT_KEY &&
  env.PONZU_SESSION_FILE;

/** A name no other run has, for the branches and the canvas a run makes. */
const uniqueTag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * What the real services are told of themselves: where previews are served from, for the pull
 * request's description, and the App's slug, which marks its own bot in what is read.
 */
const liveConfig = () =>
  ({
    assetsUrl: "https://assets.ponzu.cloud",
    githubApp: { slug: env.GITHUB_APP_SLUG ?? "", webhookSecret: "", botUserId: 0 },
  }) as Config;

/** The real GitHub client, made only once a test runs: a skipped one reads no key. */
const liveGithub = (fetchVia: Fetch = (url, init) => fetch(url, init)) =>
  createGithub({
    clientId: env.GITHUB_APP_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
    privateKey: readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH ?? "", "utf8"),
    fetch: (url, init) => fetchVia(url, init),
    clock: systemClock,
  });

/** The developer the session file names, as the live database has them. */
async function developerOf(db: Db): Promise<User> {
  const session = JSON.parse(readFileSync(env.PONZU_SESSION_FILE ?? "", "utf8"));
  const user = await getUser(db, session.user.id);
  if (!user) throw new Error("The developer in the session file has no user on this database.");
  return user;
}

/** The test repository's row, on whichever workspace has it on the live database. */
async function testRepo(db: Db, fullName: string) {
  const repo = (await db.select().from(repos)).find((row) => row.fullName === fullName);
  if (!repo) throw new Error(`${fullName} is not a repo of any workspace on this database.`);
  return repo;
}

/** A REST call as the App with a token for the test repository's contents and pull requests. */
async function asApp(
  github: Github,
  fullName: string,
  installationId: number,
  repositoryId: number,
) {
  const { token } = await github.createInstallationToken({
    installationId,
    repositoryIds: [repositoryId],
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  });
  const rest = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`https://api.github.com/repos/${fullName}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  return { token, rest };
}

/** git, with the token as its credential for github.com and nothing else configured. */
async function git(cwd: string, token: string, ...args: string[]) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: env.PATH ?? "",
      HOME: cwd,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) {
    const said = (await new Response(child.stderr).text()).replaceAll(token, "<token>");
    throw new Error(`git ${args[0]} failed: ${said.slice(0, 300)}`);
  }
}

/** One commit on a new `branch` made from `from`, pushed with git as the sandbox pushes. */
async function pushCommit(
  fullName: string,
  token: string,
  user: User,
  { branch, from, file }: { branch: string; from: string; file: string },
  cleanup: (() => Promise<unknown>)[],
) {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-live-"));
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  await git(dir, token, "init", "-q");
  await git(dir, token, "remote", "add", "origin", `https://github.com/${fullName}.git`);
  await git(dir, token, "fetch", "-q", "--depth", "1", "origin", from);
  await git(dir, token, "checkout", "-q", "-b", branch, "FETCH_HEAD");
  writeFileSync(join(dir, file), `A live check of Ponzu's pull requests, ${file}.\n`);
  await git(dir, token, "add", ".");
  await git(
    dir,
    token,
    "-c",
    `user.name=${user.name ?? user.githubLogin}`,
    "-c",
    `user.email=${user.githubUserId}+${user.githubLogin}@users.noreply.github.com`,
    "commit",
    "-q",
    "-m",
    "Add a live check",
  );
  await git(dir, token, "push", "-q", "origin", branch);
}

describe.skipIf(!configured)("a canvas's pull request on GitHub, for real", () => {
  const fullName = env.GITHUB_TEST_REPO ?? "";
  const background: Promise<unknown>[] = [];
  /** The real services, made only once the test runs: a skipped one reads no key. */
  const liveDeps = () => ({
    db: createDb(env.DATABASE_URL ?? ""),
    github: liveGithub(),
    clock: systemClock,
    vault: createVault({ key: env.PONZU_VAULT_KEY ?? "" }),
    log: createLogger(() => {}),
    analytics: noAnalytics,
    // Nothing here pings a phone.
    push: noPush,
    mail: noMail,
    background: (_name: string, work: Promise<unknown>) => {
      background.push(work.catch(() => {}));
    },
    config: liveConfig(),
    // Every switch off, as the dev deployment has them: a merge-queue repo is refused, not queued.
    features: FEATURES_OFF,
    // A canvas with no previews yet copies none into its pull request.
    storage: new Proxy({} as ObjectStorage, {
      get: () => () => Promise.reject(new Error("The live test uses no storage.")),
    }),
    // No sandbox here holds commits GitHub lacks, so Create PR never asks one to push.
    ...({} as Pick<JobDeps, "sandboxes" | "runnerBundle" | "poke" | "workos">),
    posthogAdmin: null,
  });
  const tag = uniqueTag();
  const base = `pz-live-base-${tag}`;
  const branch = `pz/live-${tag}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    await Promise.all(background);
    for (const step of cleanup.reverse()) await step().catch(() => {});
  });

  test("pushed, opened and merged as the person, read as the App, and the canvas settled", async () => {
    const deps = liveDeps();
    const { db, github } = deps;
    const repo = await testRepo(db, fullName);
    const user = await developerOf(db);

    const canvas = await createCanvas(db, {
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: `Live check ${tag}`,
      branch,
      doc: emptyDoc(`Live check ${tag}`),
    });
    cleanup.push(() => deleteCanvas(db, canvas.id));
    const stored = await getPullRequestContext(db, canvas.id);
    if (!stored?.installationId)
      throw new Error("The App is not installed on the repo's workspace.");
    const { token, rest } = await asApp(github, fullName, stored.installationId, repo.githubRepoId);

    // A base of the test's own, so the default branch is left alone.
    const main = await rest("GET", `/git/ref/heads/${repo.defaultBranch}`);
    expect(main.status).toBe(200);
    expect(
      (await rest("POST", "/git/refs", { ref: `refs/heads/${base}`, sha: main.body.object.sha }))
        .status,
    ).toBe(201);
    cleanup.push(() => rest("DELETE", `/git/refs/heads/${base}`));
    // The canvas's pull request is the one into the repo's default branch, as Ponzu has it: for
    // the test, that base, until it is over.
    const setDefaultBranch = (name: string) =>
      db.execute(`update repos set default_branch = '${name}' where id = '${repo.id}'`);
    await setDefaultBranch(base);
    cleanup.push(() => setDefaultBranch(repo.defaultBranch));
    const context = (await getPullRequestContext(db, canvas.id))!;

    // One commit, pushed with git as the sandbox pushes: authored by the person.
    await pushCommit(
      fullName,
      token,
      user,
      { branch, from: base, file: `live-${tag}.md` },
      cleanup,
    );
    cleanup.push(() => rest("DELETE", `/git/refs/heads/${branch}`));

    const target = targetOf(context);
    if (target instanceof Error) throw target;
    expect((await readPullRequest(deps, target)).read.branch).toMatchObject({ aheadBy: 1 });

    const { tab, opened } = await openPullRequest(deps, context, user);
    expect(opened).toBe(true);
    // GitHub leaves a pull request open when its branches are deleted: a run that fails closes it.
    cleanup.push(() => rest("PATCH", `/pulls/${tab.pullRequest!.number}`, { state: "closed" }));
    // Its author is the person, so where the rules want a review, someone else gives it.
    expect(tab.pullRequest).toMatchObject({
      state: "draft",
      base: { ref: base },
      head: { ref: branch },
      author: { login: user.githubLogin, bot: false },
    });
    expect(tab.pullRequest!.body).toContain(`https://ponzu.design/canvases/${canvas.id}`);
    expect((await openPullRequest(deps, context, user)).opened).toBe(false);
    expect(await savePullRequestSummary(deps, canvas.id, `Adds live-${tag}.md.`)).toMatchObject({
      pullRequest: tab.pullRequest!.number,
      kept: null,
    });

    // GitHub works out whether it can merge over a few seconds.
    await Promise.all(background);
    await refreshPullRequest(deps, canvas.id);
    const read = await readPullRequest(deps, target);
    expect(read.read.pullRequest).toMatchObject({
      body: expect.stringContaining(`Adds live-${tag}.md.`),
      files: { total: 1, items: [{ path: `live-${tag}.md`, change: "added", additions: 1 }] },
      commits: { total: 1 },
      mergeable: true,
    });
    const file = await github.readPullRequestFile(
      target.repo,
      tab.pullRequest!.number,
      `live-${tag}.md`,
    );
    expect(file?.patch).toContain(tag);

    const ready = await actOnPullRequest(deps, context, user, { kind: "ready" });
    expect(ready.pullRequest?.state).toBe("open");
    // The test repo does not allow auto-merge, and says so.
    await expect(
      actOnPullRequest(deps, context, user, { kind: "auto_merge", enabled: true }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/auto_merge_not_allowed|already_mergeable/),
    });
    await expect(
      actOnPullRequest(deps, context, user, {
        kind: "merge",
        headSha: "0".repeat(40),
        bypass: false,
      }),
    ).rejects.toMatchObject({ code: "head_moved" });

    // The base moves on, and the branch is brought up to date with it as the person.
    const moved = await rest("PUT", `/contents/live-base-${tag}.md`, {
      message: "Move the base on",
      content: Buffer.from(`The base moved, ${tag}.\n`).toString("base64"),
      branch: base,
    });
    expect(moved.status).toBe(201);
    const behind = await readPullRequest(deps, target);
    expect(behind.read.branch).toMatchObject({ behindBy: 1 });
    await actOnPullRequest(deps, context, user, {
      kind: "update_branch",
      headSha: ready.pullRequest!.head.sha,
    });
    await Promise.all(background);
    // GitHub makes the merge commit a moment after it answers.
    let updated = await readPullRequest(deps, target);
    for (let tries = 0; tries < 15 && updated.read.branch?.behindBy !== 0; tries++) {
      await systemClock.sleep(1_000);
      updated = await readPullRequest(deps, target);
    }
    await refreshPullRequest(deps, canvas.id);
    updated = await readPullRequest(deps, target);
    expect(updated.read.branch).toMatchObject({ behindBy: 0 });
    expect(updated.read.pullRequest!.head.sha).not.toBe(ready.pullRequest!.head.sha);

    const merged = await actOnPullRequest(deps, context, user, {
      kind: "merge",
      headSha: updated.read.pullRequest!.head.sha,
      bypass: false,
    });
    expect(merged.pullRequest).toMatchObject({
      state: "merged",
      mergedBy: { login: user.githubLogin, bot: false },
    });
    expect(await getCanvas(db, canvas.id)).toMatchObject({
      prNumber: tab.pullRequest!.number,
      prState: "merged",
      status: "settled",
    });
    const notices = (await listThreadItems(db, { canvasId: canvas.id }))
      .filter((item) => item.kind === "notice")
      .map((item) => (item.payload as { state: string }).state);
    expect(notices).toEqual(["draft", "merged"]);
  }, 120_000);
});

/*
 * The agent's pull request, as one story told twice: against the fake GitHub in every `bun test`,
 * and against the real one with the env above. Everything but how a branch is made, how a
 * commit gets to GitHub and how long GitHub takes is the same code and the same assertions.
 */

/** GitHub as the test reaches it around the API, for the canvas's repository. */
interface Hands {
  /** A branch at `from`'s head. */
  branch(name: string, from: string): Promise<void>;
  /** One commit adding `file`, on a new `branch` made from `from`, authored by the developer. */
  commit(branch: string, from: string, file: string): Promise<void>;
  /** Deletes a branch; one already gone is no matter. */
  remove(branch: string): Promise<void>;
  /** Closes the pull request if it is still open. */
  close(number: number): Promise<void>;
}

/** What one telling of the story runs on. */
interface AgentRig {
  /** The whole API, as `createApp` makes it. */
  app: ReturnType<typeof createApp>;
  db: Db;
  /** The API's clock: the fake one moves only when slept on. */
  clock: Clock;
  repo: { id: string; workspaceId: string; fullName: string; defaultBranch: string };
  /** The person whose message begins the turn. */
  developer: User;
  /** GitHub for the canvas's repository, once the canvas exists. */
  hands(canvasId: string): Promise<Hands>;
  /** How many requests the API has sent GitHub so far. */
  requests(): number;
  /** Waits for what the API handed to the background. */
  idle(): Promise<void>;
}

/** The thread notice's word for each thing the agent did (`agent.ts`, `DONE`). */
const DONE = ["opened", "ready", "updated_branch", "auto_merge", "merged"] as const;

/**
 * The agent's pull request, start to end: a canvas on the repo with a runner holding its lease
 * and a message from the developer handed to it and acknowledged; a commit on the canvas's
 * branch; then, through the runner's routes with a runner token for the canvas, open (a draft),
 * read, ready, update the branch, auto-merge and merge. Each thing done is one
 * `pull_request_agent` line in the thread naming the developer, and is what the hour's limits
 * count; the merge is the developer's, and the canvas settles. Then a turn a review began may
 * not merge, and GitHub never hears of the try. Cleans up after itself whatever fails.
 */
async function agentStory(rig: AgentRig): Promise<void> {
  const { app, db, clock, repo, developer } = rig;
  const tag = uniqueTag();
  const base = `pz-agent-base-${tag}`;
  const branch = `pz/agent-${tag}`;
  const file = `agent-${tag}.md`;
  const cleanup: (() => Promise<unknown>)[] = [];
  const now = () => new Date(clock.now());
  try {
    const canvas = await createCanvas(db, {
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      ownerId: developer.id,
      claudeAccountId: null,
      name: `Agent check ${tag}`,
      branch,
      doc: emptyDoc(`Agent check ${tag}`),
    });
    cleanup.push(() => deleteCanvas(db, canvas.id));
    const github = await rig.hands(canvas.id);

    // A base of the test's own, which the database calls the repo's default branch while it
    // runs, so the repository's own is left alone.
    await github.branch(base, repo.defaultBranch);
    cleanup.push(() => github.remove(base));
    const setDefaultBranch = (name: string) =>
      db.execute(`update repos set default_branch = '${name}' where id = '${repo.id}'`);
    await setDefaultBranch(base);
    cleanup.push(() => setDefaultBranch(repo.defaultBranch));

    // The canvas's runner, holding its lease, and the developer's message handed to it and taken
    // into its session: the turn the agent's calls name is the developer's.
    const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: now() });
    const handOver = async (event: FeedEvent) => {
      await claimEvents(db, { canvasId: canvas.id, runnerId, claimId: newId("clm"), now: now() });
      // Each its own acknowledgement, later than the last: the order the session took them in.
      await clock.sleep(1);
      const acked = await markEventsDelivered(db, {
        canvasId: canvas.id,
        runnerId,
        ids: [event.id],
        claudeSessionId: `sess_agent_${tag}`,
        now: now(),
      });
      expect(acked).toBe(1);
      return event.id;
    };
    const asked = await handOver(
      await appendEvent(db, {
        canvasId: canvas.id,
        kind: "message",
        priority: "now",
        payload: { text: "Open a pull request for this and merge it." },
        userId: developer.id,
      }),
    );
    const { token } = await createRunnerToken(db, { canvasId: canvas.id, ttlSeconds: 3600 });
    const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: runnerId };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await app.request(`/v1/runner/pull-request${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const act = (action: string, body: Record<string, unknown>) => call("POST", `/${action}`, body);
    const read = async (turn: string) => {
      const answer = await call("GET", `?turn=${turn}`);
      expect(answer.status).toBe(200);
      return answer.body;
    };
    /** Reads until GitHub knows whether it can merge, as it takes a few seconds to. */
    const settled = async (turn: string) => {
      await rig.idle();
      let standing = await read(turn);
      for (let tries = 0; tries < 15 && standing.pullRequest?.mergeable === null; tries++) {
        await clock.sleep(1_000);
        standing = await read(turn);
      }
      return standing;
    };

    // One commit on the canvas's branch, pushed as the sandbox pushes it.
    await github.commit(branch, base, file);
    cleanup.push(() => github.remove(branch));

    const developerName = developer.name ?? developer.githubLogin;
    const actingAs = { name: developerName, login: developer.githubLogin };

    // Open, as a draft, as the developer.
    const opened = await act("open", { turn: asked });
    const pr = opened.body.pullRequest;
    // GitHub leaves a pull request open when its branches are deleted: a run that fails closes
    // it, so its close is registered before anything about it is asserted.
    if (typeof pr?.number === "number") cleanup.push(() => github.close(pr.number));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      did: true,
      pushing: false,
      pullRequest: { state: "draft", author: developer.githubLogin },
      branch: { name: branch, base },
      actingAs,
      personTurn: true,
      notPersonTurn: null,
    });
    // Read: where it stands, and who the agent acts as.
    const standing = await settled(asked);
    expect(standing).toMatchObject({
      branch: { name: branch, base, exists: true, aheadBy: 1, behindBy: 0 },
      pullRequest: { number: pr.number, state: "draft", mergeable: true },
      actingAs,
      personTurn: true,
    });

    // Ready.
    const ready = await act("ready", { turn: asked });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ did: true, pullRequest: { state: "open" } });

    // Update the branch: up to date with a base nobody moved, or brought up to it.
    const update = await act("update-branch", {
      turn: asked,
      headSha: ready.body.pullRequest.headSha,
    });
    const updated = update.status === 200;
    if (updated) expect(update.body).toMatchObject({ did: true });
    else expect([update.status, update.body.error.code]).toEqual([409, "branch_up_to_date"]);

    // Auto-merge: refused where the repo does not allow it, or where nothing is left to wait for.
    const beforeAuto = await settled(asked);
    const auto = await act("auto-merge", { turn: asked });
    const autoOn = auto.status === 200 && auto.body.did === true;
    if (!beforeAuto.autoMergeAllowed) {
      expect([auto.status, auto.body.error.code]).toEqual([409, "auto_merge_not_allowed"]);
    } else if (autoOn) {
      expect(auto.body.pullRequest.autoMerge).toEqual({ enabledBy: developer.githubLogin });
    } else {
      expect([auto.status, auto.body.error.code]).toEqual([409, "already_mergeable"]);
    }

    // Merge, at the commit it read, as the developer.
    const head = (await settled(asked)).pullRequest.headSha;
    const merge = await act("merge", { turn: asked, headSha: head });
    expect(merge.status).toBe(200);
    expect(merge.body.pullRequest).toMatchObject({
      number: pr.number,
      state: "merged",
      mergedBy: developer.githubLogin,
    });
    // Auto-merge, once on, may have merged it first: then this call did nothing.
    const mergedByAgent = merge.body.did === true;
    if (!autoOn) expect(mergedByAgent).toBe(true);
    await rig.idle();

    // One line in the thread for each thing done, naming the developer.
    const did = new Set<string>([
      "opened",
      "ready",
      ...(updated ? ["updated_branch"] : []),
      ...(autoOn ? ["auto_merge"] : []),
      ...(mergedByAgent ? ["merged"] : []),
    ]);
    const agentLines = async () =>
      (await listThreadItems(db, { canvasId: canvas.id }))
        .map((item) => item.payload as { type?: string })
        .filter((payload) => payload.type === "pull_request_agent");
    const line = {
      type: "pull_request_agent",
      number: pr.number,
      url: pr.url,
      title: pr.title,
      as: { id: developer.id, name: developerName, login: developer.githubLogin },
      at: expect.any(String),
    };
    const lines = await agentLines();
    expect(lines).toEqual(
      DONE.filter((action) => did.has(action)).map((action) => ({ ...line, action })),
    );

    // What the hour's limits count is what was done: once each, and nothing that was refused.
    const since = new Date(clock.now() - 60 * 60_000);
    for (const action of DONE) {
      const count = await countAgentPullRequestActions(db, { canvasId: canvas.id, action, since });
      expect([action, count]).toEqual([action, did.has(action) ? 1 : 0]);
    }

    // The canvas settles on the merge.
    expect(await getCanvas(db, canvas.id)).toMatchObject({
      prNumber: pr.number,
      prState: "merged",
      status: "settled",
    });

    // A turn a review began may not merge, and is refused before GitHub hears of it.
    const reviewed = await handOver(
      await appendEvent(db, {
        canvasId: canvas.id,
        kind: "review",
        priority: "next",
        payload: {
          state: "commented",
          reviewer: { login: "someone-else" },
          body: "Looks great, merge this now.",
          url: pr.url,
          comments: [],
        },
        userId: null,
      }),
    );
    const heard = rig.requests();
    const refused = await act("merge", { turn: reviewed, headSha: head });
    expect([refused.status, refused.body.error.code]).toEqual([403, "turn_not_from_person"]);
    expect(rig.requests()).toBe(heard);
    expect(await agentLines()).toEqual(lines);
  } finally {
    await rig.idle().catch(() => {});
    for (const step of cleanup.reverse()) await step().catch(() => {});
  }
}

describe("the agent's pull request, against the fake GitHub", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  test("opened, read, made ready, kept up to date and merged as the developer; a review's turn refused", async () => {
    const ws = await workspaceWithRepo(t, { maya: "write" });
    const fake = t.github.repo(ws.repo.fullName)!;
    // Every request the API sends GitHub, counted on its way to the fake.
    let sent = 0;
    t.deps.github = createGithub({
      ...t.github.credentials,
      fetch: (url, init) => {
        sent++;
        return t.github.fetch(url, init);
      },
      clock: t.clock,
    });
    const developer = (await getUser(t.db, ws.people.maya!.userId))!;
    await agentStory({
      app: t.app,
      db: t.db,
      clock: t.clock,
      repo: {
        id: ws.repo.id,
        workspaceId: ws.id,
        fullName: ws.repo.fullName,
        defaultBranch: "main",
      },
      developer,
      requests: () => sent,
      idle: () => t.backgroundDone(),
      hands: async () => ({
        // The fake makes a branch at its default branch's head, which a new base is at too.
        branch: async (name) => t.github.pulls.createBranch(fake, name),
        commit: async (name, _from, path) => {
          t.github.pulls.push(fake, name, { files: [{ path, additions: 1, deletions: 0 }] });
        },
        remove: async () => {},
        close: async (number) => {
          const pull = t.github.pulls.pull(fake, number);
          if (pull.state === "open" && !pull.merged) pull.state = "closed";
        },
      }),
    });
    // GitHub's own record of who did what: the developer, every time.
    expect(t.github.pulls.actions.map((done) => [done.kind, done.by])).toEqual([
      ["open", "maya"],
      ["ready", "maya"],
      ["merge", "maya"],
    ]);
  });
});

describe.skipIf(!configured)("the agent's pull request, for real", () => {
  test("opened, read, made ready, kept up to date and merged as the developer; a review's turn refused", async () => {
    const fullName = env.GITHUB_TEST_REPO ?? "";
    const background: Promise<unknown>[] = [];
    // Every request the API sends GitHub, counted on its way out.
    let sent = 0;
    const github = liveGithub((url, init) => {
      sent++;
      return fetch(url, init);
    });
    const refuse = <T extends object>(what: string) =>
      new Proxy({} as T, {
        get: (_target, key) =>
          key === "then"
            ? undefined
            : () => {
                throw new Error(`The live test uses no ${what}.`);
              },
      });
    const db = createDb(env.DATABASE_URL ?? "");
    const deps: Deps = {
      db,
      clock: systemClock,
      ids: randomIds,
      log: createLogger(() => {}),
      background: (_name, work) => {
        background.push(work.catch(() => {}));
      },
      vault: createVault({ key: env.PONZU_VAULT_KEY ?? "" }),
      github,
      // What the agent's routes never reach: a call to one fails the test, loudly.
      workos: refuse("WorkOS"),
      sandboxes: refuse("sandboxes"),
      runnerBundle: () => {
        throw new Error("The live test serves no runner bundle.");
      },
      anthropic: refuse("Anthropic"),
      storage: refuse("storage"),
      archives: refuse("archives"),
      model: refuse("model"),
      reviewer: refuse("reviewer"),
      realtime: refuse("Realtime"),
      // Nothing is awake to poke: the runner here is the test.
      poke: async () => {},
      runnerTool: async () => {
        throw new Error("The live test relays no canvas tools.");
      },
      docs: new DocCache(),
      gitTokens: new GitTokens(),
      analytics: noAnalytics,
      posthogAdmin: null,
      // Nothing here pings a phone or sends mail, nor is limited.
      push: noPush,
      mail: noMail,
      rateLimit: noRateLimit,
      // Every switch off, as the dev deployment has them.
      features: FEATURES_OFF,
      config: {
        ...liveConfig(),
        build: { version: "0.0.0-live", commit: null, environment: "local" },
        minimumClientVersions: {},
        posthog: null,
        cronSecret: "",
        sandbox: {} as SandboxConfig,
        email: EMAIL_CONFIG_UNSET,
      },
    };
    const repo = await testRepo(db, fullName);
    // What it restores at the end: never a base an earlier run failed to put back.
    if (/^pz-(live|agent)-base-/.test(repo.defaultBranch)) {
      throw new Error(
        `${fullName}'s default branch on this database is ${repo.defaultBranch}, a test's base: put the real one back first.`,
      );
    }
    await agentStory({
      app: createApp(deps),
      db,
      clock: systemClock,
      repo: {
        id: repo.id,
        workspaceId: repo.workspaceId,
        fullName,
        defaultBranch: repo.defaultBranch,
      },
      developer: await developerOf(db),
      requests: () => sent,
      idle: async () => {
        while (background.length > 0) await background.shift();
      },
      hands: async (canvasId) => {
        const stored = await getPullRequestContext(db, canvasId);
        if (!stored?.installationId)
          throw new Error("The App is not installed on the repo's workspace.");
        // Its own client, so what the test does around the API is not counted as the API's.
        const { token, rest } = await asApp(
          liveGithub(),
          fullName,
          stored.installationId,
          repo.githubRepoId,
        );
        const developer = await developerOf(db);
        const scratch: (() => Promise<unknown>)[] = [];
        const hands: Hands = {
          branch: async (name, from) => {
            const at = await rest("GET", `/git/ref/heads/${from}`);
            expect(at.status).toBe(200);
            const made = await rest("POST", "/git/refs", {
              ref: `refs/heads/${name}`,
              sha: at.body.object.sha,
            });
            expect(made.status).toBe(201);
          },
          commit: async (name, from, path) => {
            try {
              await pushCommit(
                fullName,
                token,
                developer,
                { branch: name, from, file: path },
                scratch,
              );
            } finally {
              for (const step of scratch.splice(0)) await step().catch(() => {});
            }
          },
          remove: async (name) => {
            await rest("DELETE", `/git/refs/heads/${name}`);
          },
          close: async (number) => {
            const pull = await rest("GET", `/pulls/${number}`);
            if (pull.body?.state === "open") {
              await rest("PATCH", `/pulls/${number}`, { state: "closed" });
            }
          },
        };
        return hands;
      },
    });
  }, 180_000);
});

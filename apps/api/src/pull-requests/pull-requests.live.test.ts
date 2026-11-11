// The real GitHub, through this module's own functions: a branch pushed with git and a one-hour
// installation token, its pull request opened as the developer with their own GitHub token, read
// as the App until GitHub knows whether it can merge, marked ready, brought up to date with its
// base and merged as the developer, the design settled, and the branches deleted. It merges into
// a branch of its own made from the default branch, which the database calls the repo's default
// branch while it runs, so the repository's own is left as it was; the closed pull request
// stays, as GitHub cannot delete one.
//
// Not covered here: a base the repo's rules protect. Making one takes the repo's administration
// permission, which neither the App nor a token acting through it has.
//
// Skipped unless GITHUB_TEST_REPO (owner/name, where the App is installed), the App's
// GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY_PATH, DATABASE_URL
// (the Neon `dev` branch, with this branch's migrations), PONZU_VAULT_KEY and PONZU_SESSION_FILE
// are set. The session file only says who the developer is (its `user.id`); its tokens are not
// used. Their GitHub token is the one the API keeps, refreshed by `githubUserToken` as the API
// would.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDoc } from "@ponzu/core";
import {
  createDb,
  createDesign,
  deleteDesign,
  getDesign,
  getPullRequestContext,
  getUser,
  listThreadItems,
  repos,
} from "@ponzu/db";
import { systemClock } from "@ponzu/sandbox";
import { noAnalytics } from "../analytics/analytics.ts";
import { createGithub, type Github } from "../deps/github.ts";
import type { Config } from "../deps/index.ts";
import type { ObjectStorage } from "../deps/storage.ts";
import { createLogger } from "../http/log.ts";
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

describe.skipIf(!configured)("a design's pull request on GitHub, for real", () => {
  const fullName = env.GITHUB_TEST_REPO ?? "";
  const background: Promise<unknown>[] = [];
  /** The real services, made only once the test runs: a skipped one reads no key. */
  const liveDeps = () => ({
    db: createDb(env.DATABASE_URL ?? ""),
    github: createGithub({
      clientId: env.GITHUB_APP_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
      privateKey: readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH ?? "", "utf8"),
      fetch: (url, init) => fetch(url, init),
      clock: systemClock,
    }),
    clock: systemClock,
    vault: createVault({ key: env.PONZU_VAULT_KEY ?? "" }),
    log: createLogger(() => {}),
    analytics: noAnalytics,
    background: (_name: string, work: Promise<unknown>) => {
      background.push(work.catch(() => {}));
    },
    // Only where previews are served from is read, for the pull request's description.
    config: { assetsUrl: "https://assets.ponzu.cloud" } as Config,
    // A design with no previews yet copies none into its pull request.
    storage: new Proxy({} as ObjectStorage, {
      get: () => () => Promise.reject(new Error("The live test uses no storage.")),
    }),
  });
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const base = `pz-live-base-${tag}`;
  const branch = `pz/live-${tag}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    await Promise.all(background);
    for (const step of cleanup.reverse()) await step().catch(() => {});
  });

  /** A REST call as the App with a token for the test repository's contents and pull requests. */
  async function asApp(github: Github, installationId: number, repositoryId: number) {
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

  test("pushed, opened and merged as the person, read as the App, and the design settled", async () => {
    const deps = liveDeps();
    const { db, github } = deps;
    const repo = (await db.select().from(repos)).find((row) => row.fullName === fullName);
    if (!repo) throw new Error(`${fullName} is not a repo of any workspace on this database.`);
    const session = JSON.parse(readFileSync(env.PONZU_SESSION_FILE ?? "", "utf8"));
    const user = await getUser(db, session.user.id);
    if (!user) throw new Error("The developer in the session file has no user on this database.");

    const design = await createDesign(db, {
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: `Live check ${tag}`,
      branch,
      doc: emptyDoc(`Live check ${tag}`),
    });
    cleanup.push(() => deleteDesign(db, design.id));
    const stored = await getPullRequestContext(db, design.id);
    if (!stored?.installationId)
      throw new Error("The App is not installed on the repo's workspace.");
    const { token, rest } = await asApp(github, stored.installationId, repo.githubRepoId);

    // A base of the test's own, so the default branch is left alone.
    const main = await rest("GET", `/git/ref/heads/${repo.defaultBranch}`);
    expect(main.status).toBe(200);
    expect(
      (await rest("POST", "/git/refs", { ref: `refs/heads/${base}`, sha: main.body.object.sha }))
        .status,
    ).toBe(201);
    cleanup.push(() => rest("DELETE", `/git/refs/heads/${base}`));
    // The design's pull request is the one into the repo's default branch, as Ponzu has it: for
    // the test, that base, until it is over.
    const setDefaultBranch = (name: string) =>
      db.execute(`update repos set default_branch = '${name}' where id = '${repo.id}'`);
    await setDefaultBranch(base);
    cleanup.push(() => setDefaultBranch(repo.defaultBranch));
    const context = (await getPullRequestContext(db, design.id))!;

    // One commit, pushed with git as the sandbox pushes: authored by the person.
    const dir = mkdtempSync(join(tmpdir(), "ponzu-live-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    await git(dir, token, "init", "-q");
    await git(dir, token, "remote", "add", "origin", `https://github.com/${fullName}.git`);
    await git(dir, token, "fetch", "-q", "--depth", "1", "origin", base);
    await git(dir, token, "checkout", "-q", "-b", branch, "FETCH_HEAD");
    writeFileSync(join(dir, `live-${tag}.md`), `A live check of Ponzu's pull requests, ${tag}.\n`);
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
    expect(tab.pullRequest!.body).toContain(`https://ponzu.design/designs/${design.id}`);
    expect((await openPullRequest(deps, context, user)).opened).toBe(false);
    expect(await savePullRequestSummary(deps, design.id, `Adds live-${tag}.md.`)).toBe(
      tab.pullRequest!.number,
    );

    // GitHub works out whether it can merge over a few seconds.
    await Promise.all(background);
    await refreshPullRequest(deps, design.id);
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
    await refreshPullRequest(deps, design.id);
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
    expect(await getDesign(db, design.id)).toMatchObject({
      prNumber: tab.pullRequest!.number,
      prState: "merged",
      status: "settled",
    });
    const notices = (await listThreadItems(db, { designId: design.id }))
      .filter((item) => item.kind === "notice")
      .map((item) => (item.payload as { state: string }).state);
    expect(notices).toEqual(["draft", "merged"]);
  }, 120_000);
});

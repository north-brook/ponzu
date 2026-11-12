import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  createCanvas,
  deleteUser,
  getCanvas,
  getCanvasAssetKey,
  getSandbox,
  recordUsage,
  upsertMembership,
  upsertRepos,
  upsertWorkspace,
} from "@ponzu/db";
import { canvasSandboxName } from "@ponzu/sandbox";
import { ACCOUNT_FORGET_JOB } from "../account/forget.ts";
import { CANVAS_FILES_DELETE_JOB, FILES_RETRY_MS } from "../canvases/files.ts";
import { githubUserToken } from "../github/user-token.ts";
import { runDueJobs } from "../jobs/run.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type SignedInPerson, TEST_SCOPE, type TestApp } from "../testing/index.ts";

/*
 * Deleting an account through the route: what blocks it, what goes, what stays with the team,
 * and what is left of the person in what stays.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-rae-deletes-her-account-0000";

beforeAll(async () => {
  // With PostHog's personal key, as production will have it once the founder sets it.
  t = await createTestApp({ posthogAdmin: true });
  ws = await workspaceWithRepo(t, { rae: "admin", sol: "admin", tom: "write" });
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;

/** Rows of a statement the test writes itself. */
async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

describe("refusals", () => {
  test("the confirmation must be the person's GitHub login", async () => {
    const wrong = await call(t, await as("tom"), "DELETE", "/v1/me", { confirm: "rae" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("confirmation_mismatch");
    const none = await call(t, await as("tom"), "DELETE", "/v1/me", {});
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("invalid_request");
  });

  test("the only admin of a team others are in must make someone else one first", async () => {
    const team = await workspaceWithRepo(t, { una: "admin", vic: "write" });
    const refused = await call(t, await as("una"), "DELETE", "/v1/me", { confirm: "una" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: "sole_admin",
      details: { workspaces: [{ id: team.id, name: team.github.installation.account.login }] },
    });
    // Nothing happened: she is still here.
    expect((await call(t, await as("una"), "GET", "/v1/me")).status).toBe(200);
  });

  test("two admins deleting themselves at once leave the team one of them", async () => {
    const team = await workspaceWithRepo(t, { wes: "admin", xan: "admin", yul: "write" });
    const [wes, xan] = await Promise.all([as("wes"), as("xan")]);
    const answers = await Promise.all([
      call(t, wes, "DELETE", "/v1/me", { confirm: "wes" }),
      call(t, xan, "DELETE", "/v1/me", { confirm: "xan" }),
    ]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([204, 409]);
    const admins = await rows(
      `select user_id from memberships where workspace_id = '${team.id}' and role = 'admin'`,
    );
    expect(admins).toHaveLength(1);
  });

  test("the last admin is checked again as the row goes", async () => {
    const team = await workspaceWithRepo(t, { zia: "admin", abe: "admin", bo: "write" });
    // As though Abe's deletion went through after Zia's plan was made.
    await t.db.execute(
      `delete from memberships where workspace_id = '${team.id}' and user_id = '${team.people.abe!.userId}'`,
    );
    expect(
      await deleteUser(t.db, team.people.zia!.userId, {
        kind: ACCOUNT_FORGET_JOB,
        maxAttempts: 1,
        runAt: new Date(),
      }),
    ).toEqual({ status: "sole_admin" });
    expect((await call(t, await as("zia"), "GET", "/v1/me")).status).toBe(200);
  });
});

describe("a personal account others are in", () => {
  let dee: SignedInPerson;
  let own: { id: string };
  let deesCanvas: string;

  beforeAll(async () => {
    dee = await t.signInAs({ login: "dee" });
    const eli = await t.signInAs({ login: "eli" });
    own = await upsertWorkspace(t.db, {
      githubAccountId: dee.github.id,
      githubLogin: "dee",
      kind: "personal",
      name: "dee",
      avatarUrl: null,
      installationId: 880_101,
      repositorySelection: "selected",
      installedByUserId: null,
    });
    const [repo] = await upsertRepos(t.db, {
      workspaceId: own.id,
      repos: [
        {
          githubRepoId: 880_102,
          fullName: "dee/site",
          defaultBranch: "main",
          private: true,
          pushedAt: null,
        },
      ],
    });
    await upsertMembership(t.db, {
      workspaceId: own.id,
      userId: dee.userId,
      role: "admin",
      githubAccess: "owner",
    });
    // A collaborator on her repo, whom Ponzu lets into her account's workspace.
    await upsertMembership(t.db, {
      workspaceId: own.id,
      userId: eli.userId,
      role: "member",
      githubAccess: "collaborator",
    });
    deesCanvas = (
      await createCanvas(t.db, {
        workspaceId: own.id,
        repoId: repo!.id,
        ownerId: dee.userId,
        claudeAccountId: null,
        name: "Site",
        branch: null,
        doc: sampleDoc(),
      })
    ).id;
  });

  test("is not left without an admin", async () => {
    const refused = await call(t, dee.headers, "DELETE", "/v1/me", { confirm: "dee" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: "sole_admin",
      message: "Make someone else an admin first.",
      details: { workspaces: [{ id: own.id, name: "dee" }] },
    });
    expect(await getCanvas(t.db, deesCanvas)).not.toBeNull();
  });

  test("keeps the canvas the collaborator shares once someone else is its admin", async () => {
    await t.db.execute(
      `update memberships set role = 'admin' where workspace_id = '${own.id}' and role = 'member'`,
    );
    const deleted = await call(t, dee.headers, "DELETE", "/v1/me", { confirm: "dee" });
    expect(deleted.status).toBe(204);
    expect((await getCanvas(t.db, deesCanvas))?.ownerId).toBeNull();
    expect(await rows(`select role from memberships where workspace_id = '${own.id}'`)).toEqual([
      { role: "admin" },
    ]);
  });
});

describe("deleting Rae", () => {
  let rae: SignedInPerson;
  let raesGithubToken: string;
  /** Whether her GitHub token's row was still stored while GitHub was asked to revoke it. */
  let tokenStoredDuringRevoke: boolean | null = null;
  let teamCanvas: string;
  let scratchCanvas: string;
  let ownCanvas: string;
  let solsCanvas: string;
  /** Each canvas's asset key, read before she went. */
  const assetKeys: Record<string, string> = {};
  const PULL_REQUEST_PICTURE = `pull-requests/${"p".repeat(32)}/light.png`;
  const filesOf = (canvasId: string) =>
    [...t.storage.objects.keys()].filter((key) => key.startsWith(`${assetKeys[canvasId]}/`));

  beforeAll(async () => {
    rae = await t.signInAs({ login: "rae" });
    t.anthropic.keys.add(KEY);
    expect((await call(t, rae.headers, "POST", "/v1/claude/api-key", { key: KEY })).status).toBe(
      200,
    );
    expect(
      (
        await call(t, rae.headers, "POST", "/v1/me/devices", {
          platform: "ios",
          pushToken: "ExponentPushToken[rae-phone-token-0001]",
          pushEnvironment: "production",
          installId: "rae-phone-install-0001",
        })
      ).status,
    ).toBe(201);

    // A canvas of the team's that she owns and has talked in, with its sandbox up.
    teamCanvas = (await canvasIn(t, ws, "rae", sampleDoc())).id;
    const said = await call(t, rae.headers, "POST", `/v1/canvases/${teamCanvas}/messages`, {
      text: "Tighten the pricing table",
    });
    expect(said.status).toBe(201);
    await call(t, rae.headers, "PATCH", `/v1/canvases/${teamCanvas}`, { name: "Pricing, tighter" });
    await t.backgroundDone();
    expect((await getSandbox(t.db, teamCanvas))?.state).toBe("awake");

    // Her Scratch canvas, and one in her own account's workspace.
    scratchCanvas = (await canvasIn(t, ws, "rae", sampleDoc(), "scratch")).id;
    const own = await upsertWorkspace(t.db, {
      githubAccountId: rae.github.id,
      githubLogin: "rae",
      kind: "personal",
      name: "Personal",
      avatarUrl: null,
      installationId: 880_001,
      repositorySelection: "selected",
      installedByUserId: null,
    });
    await upsertMembership(t.db, { workspaceId: own.id, userId: rae.userId, role: "admin" });
    ownCanvas = (
      await createCanvas(t.db, {
        workspaceId: own.id,
        repoId: null,
        ownerId: rae.userId,
        claudeAccountId: null,
        name: "Mine",
        branch: null,
        doc: sampleDoc(),
      })
    ).id;
    // A teammate's canvas, which is not hers to delete.
    solsCanvas = (await canvasIn(t, ws, "sol", sampleDoc())).id;

    await recordUsage(t.db, {
      id: "rae-usage",
      workspaceId: ws.id,
      canvasId: teamCanvas,
      userId: rae.userId,
      kind: "sandbox",
      seconds: 3600,
      credits: 0,
      costMicrousd: 0,
      payer: "ponzu",
      rateCardVersion: 1,
      occurredAt: new Date(t.clock.now()),
      periodStart: new Date(t.clock.now()),
    });

    // Her canvases' files: 2,500 under her Scratch canvas, a few under the others, and the
    // pictures of a pull request, which stay.
    for (const [canvasId, count] of [
      [scratchCanvas, 2500],
      [ownCanvas, 3],
      [teamCanvas, 4],
      [solsCanvas, 2],
    ] as const) {
      const key = (await getCanvasAssetKey(t.db, canvasId))!;
      assetKeys[canvasId] = key;
      for (let i = 0; i < count; i++) {
        t.storage.objects.set(`${key}/assets/${String(i).padStart(5, "0")}.png`, {
          body: new Uint8Array([i & 255]),
          headers: {},
          sha256: null,
        });
      }
    }
    t.storage.objects.set(`${PULL_REQUEST_PICTURE}`, {
      body: new Uint8Array([1]),
      headers: {},
      sha256: null,
    });

    raesGithubToken = await githubUserToken(t.deps, rae.userId);
    t.github.duringGrantRevoke = async () => {
      tokenStoredDuringRevoke =
        (await rows(`select 1 from github_user_tokens where user_id = '${rae.userId}'`)).length ===
        1;
    };
    const deleted = await call(t, rae.headers, "DELETE", "/v1/me", { confirm: "RAE" });
    t.github.duringGrantRevoke = null;
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
  });

  test("revokes her grant of the GitHub App, as the App, while her token is still stored", async () => {
    const { clientId, clientSecret } = t.github.credentials;
    // Others deleted before her in this file revoked theirs: hers is the one with her token.
    const hers = t.github.grantRevocations.filter(
      (request) => (request.body as { access_token?: string }).access_token === raesGithubToken,
    );
    expect(hers).toEqual([
      {
        clientId,
        authorization: `basic ${btoa(`${clientId}:${clientSecret}`)}`,
        body: { access_token: raesGithubToken },
      },
    ]);
    expect(tokenStoredDuringRevoke).toBe(true);
    // GitHub ended every token of hers.
    expect(t.github.accepts(raesGithubToken)).toBe(false);
    expect(t.logs.some((line) => line.event === "github_grant_revoked")).toBe(true);
  });

  test("forgets her at WorkOS and PostHog in one job, which completed", async () => {
    const [job] = await rows(
      `select payload, completed_at from jobs
        where kind = '${ACCOUNT_FORGET_JOB}' and key = '${rae.userId}'`,
    );
    expect(job?.payload).toEqual({ userId: rae.userId, workosUserId: rae.workos.id });
    expect(job?.completed_at).not.toBeNull();
    expect(t.posthogAdmin.requests.map((request) => request.body)).toContainEqual({
      distinct_ids: [rae.userId],
      delete_events: true,
      delete_recordings: true,
    });
  });

  test("says the account was deleted about no one, so PostHog does not make her again", () => {
    const said = t.analytics.of("account deleted");
    expect(said.length).toBeGreaterThan(0);
    for (const event of said) {
      expect(event.distinctId).not.toBe(rae.userId);
      expect(event.properties.$process_person_profile).toBe(false);
    }
  });

  test("logs nothing of her token, her email or the App's secret", () => {
    const logged = JSON.stringify(t.logs);
    for (const secret of [raesGithubToken, "rae@example.com", t.github.credentials.clientSecret]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("ends her sessions at once, and WorkOS forgets her", async () => {
    const after = await call(t, rae.headers, "GET", "/v1/me");
    expect(after.status).toBe(401);
    expect(t.workos.hasUser(rae.workos.id)).toBe(false);
  });

  test("leaves nothing that is only hers", async () => {
    for (const table of [
      "users where id",
      "sessions where user_id",
      "github_user_tokens where user_id",
      "memberships where user_id",
      "repo_access where user_id",
      "claude_accounts where user_id",
      "devices where user_id",
    ]) {
      expect(await rows(`select 1 from ${table} = '${rae.userId}'`)).toEqual([]);
    }
  });

  test("deletes her Scratch canvases and those in her own account", async () => {
    expect(await getCanvas(t.db, scratchCanvas)).toBeNull();
    expect(await getCanvas(t.db, ownCanvas)).toBeNull();
  });

  test("deletes those canvases' files through the same purge as one canvas, and keeps the rest", async () => {
    // Recorded as each row went, keyed by its asset key, and run at once.
    for (const canvasId of [scratchCanvas, ownCanvas]) {
      const [job] = await rows(
        `select payload from jobs
          where kind = '${CANVAS_FILES_DELETE_JOB}' and key = '${assetKeys[canvasId]}'`,
      );
      expect(job?.payload).toMatchObject({ assetKey: assetKeys[canvasId] });
    }
    expect(filesOf(ownCanvas)).toEqual([]);
    // The first attempt takes 2,000; the cron takes the rest ten seconds on.
    expect(filesOf(scratchCanvas)).toHaveLength(500);
    t.clock.advance(FILES_RETRY_MS);
    await runDueJobs(t.deps, "account-test");
    expect(filesOf(scratchCanvas)).toEqual([]);

    // What stays with the team keeps its files, and a pull request's pictures stay.
    expect(filesOf(teamCanvas)).toHaveLength(4);
    expect(filesOf(solsCanvas)).toHaveLength(2);
    expect(t.storage.objects.has(PULL_REQUEST_PICTURE)).toBe(true);
    for (const canvasId of [teamCanvas, solsCanvas]) {
      expect(await rows(`select 1 from jobs where key = '${assetKeys[canvasId]}'`)).toEqual([]);
    }
  });

  test("keeps the team's canvas, owned by nobody, its sandbox retired", async () => {
    const canvas = await getCanvas(t.db, teamCanvas);
    expect(canvas?.ownerId).toBeNull();
    expect(await getSandbox(t.db, teamCanvas)).toBeNull();
    expect(await t.sandboxes.status(canvasSandboxName(TEST_SCOPE, teamCanvas))).toBeNull();
    expect((await getCanvas(t.db, solsCanvas))?.ownerId).not.toBeNull();
  });

  test("keeps her words in the team's canvas, under a deleted user's name", async () => {
    const sol = await as("sol");
    const thread = await call(t, sol, "GET", `/v1/canvases/${teamCanvas}/thread`);
    expect(thread.status).toBe(200);
    const message = thread.body.items.find((item: { kind: string }) => item.kind === "message");
    expect(message.payload).toMatchObject({
      text: "Tighten the pricing table",
      from: { name: "Deleted user", login: "ghost" },
    });
    const ops = await rows(
      `select actor_name, actor_avatar_url from canvas_ops
        where canvas_id = '${teamCanvas}' and actor_id = '${rae.userId}'`,
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops)
      expect(op).toEqual({ actor_name: "Deleted user", actor_avatar_url: null });
    expect(JSON.stringify(thread.body)).not.toContain("Rae");
  });

  test("keeps the workspace's usage, put down to nobody", async () => {
    expect(await rows(`select user_id from usage_events where id = 'rae-usage'`)).toEqual([
      { user_id: null },
    ]);
  });

  test("leaves the team with its other admin, and without her", async () => {
    const sol = await call(t, await as("sol"), "GET", `/v1/workspaces/${ws.id}`);
    expect(sol.body.members.map((m: { githubLogin: string }) => m.githubLogin)).not.toContain(
      "rae",
    );
  });
});

describe("GitHub not revoking the grant", () => {
  const grantPath = () => `/applications/${t.github.credentials.clientId}/grant`;
  const failed = () => t.logs.filter((line) => line.event === "github_grant_revoke_failed");

  test("a GitHub error is logged with its status, and the deletion goes on", async () => {
    const cat = await t.signInAs({ login: "cat" });
    const token = await githubUserToken(t.deps, cat.userId);
    t.github.failNext(grantPath(), 500);
    const before = failed().length;
    expect((await call(t, cat.headers, "DELETE", "/v1/me", { confirm: "cat" })).status).toBe(204);
    await t.backgroundDone();
    expect(failed().slice(before)).toEqual([
      expect.objectContaining({ userId: cat.userId, status: 500 }),
    ]);
    expect(await rows(`select 1 from users where id = '${cat.userId}'`)).toEqual([]);
    expect(t.workos.hasUser(cat.workos.id)).toBe(false);
    expect(JSON.stringify(t.logs)).not.toContain(token);
  });

  test("a grant GitHub no longer has is done", async () => {
    const dot = await t.signInAs({ login: "dot" });
    // She revoked Ponzu on GitHub herself, and the webhook has not come yet.
    const token = await githubUserToken(t.deps, dot.userId);
    t.github.revokeTokens(dot.github.id);
    const before = failed().length;
    expect((await call(t, dot.headers, "DELETE", "/v1/me", { confirm: "dot" })).status).toBe(204);
    // GitHub answers 404 for a token it no longer has, which is what was wanted.
    expect(t.github.grantRevocations.at(-1)?.body).toEqual({ access_token: token });
    expect(failed().length).toBe(before);
    expect(await rows(`select 1 from users where id = '${dot.userId}'`)).toEqual([]);
  });

  test("GitHub slower than ten seconds is given up on, and the deletion goes on", async () => {
    const eve = await t.signInAs({ login: "eve" });
    const held = t.github.holdNext(grantPath());
    const before = failed().length;
    const deleting = call(t, eve.headers, "DELETE", "/v1/me", { confirm: "eve" });
    await held.reached;
    t.clock.advance(10_000);
    expect((await deleting).status).toBe(204);
    held.release();
    await t.backgroundDone();
    expect(failed().slice(before)).toEqual([
      expect.objectContaining({ userId: eve.userId, reason: "timeout" }),
    ]);
    expect(await rows(`select 1 from users where id = '${eve.userId}'`)).toEqual([]);
  });
});

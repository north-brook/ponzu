import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  createCanvas,
  deleteUser,
  getCanvas,
  getSandbox,
  recordUsage,
  upsertMembership,
  upsertRepos,
  upsertWorkspace,
} from "@ponzu/db";
import { canvasSandboxName } from "@ponzu/sandbox";
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
  t = await createTestApp();
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
    expect(await deleteUser(t.db, team.people.zia!.userId)).toEqual({ status: "sole_admin" });
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
  let teamCanvas: string;
  let scratchCanvas: string;
  let ownCanvas: string;
  let solsCanvas: string;

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

    const deleted = await call(t, rae.headers, "DELETE", "/v1/me", { confirm: "RAE" });
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
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

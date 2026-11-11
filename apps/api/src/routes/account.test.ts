import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  createDesign,
  getDesign,
  getLiveSandbox,
  recordUsage,
  upsertMembership,
  upsertWorkspace,
} from "@ponzu/db";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";

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
});

describe("deleting Rae", () => {
  let rae: SignedInPerson;
  let teamDesign: string;
  let scratchDesign: string;
  let ownDesign: string;
  let solsDesign: string;

  beforeAll(async () => {
    rae = await t.signInAs({ login: "rae" });
    t.anthropic.keys.add(KEY);
    expect((await call(t, rae.headers, "POST", "/v1/claude/api-key", { key: KEY })).status).toBe(
      200,
    );
    await call(t, rae.headers, "POST", "/v1/me/devices", {
      platform: "ios",
      pushToken: "b".repeat(64),
      pushEnvironment: "production",
    });

    // A design of the team's that she owns and has talked in, with its sandbox up.
    teamDesign = (await designIn(t, ws, "rae", sampleDoc())).id;
    const said = await call(t, rae.headers, "POST", `/v1/designs/${teamDesign}/messages`, {
      text: "Tighten the pricing table",
    });
    expect(said.status).toBe(201);
    await call(t, rae.headers, "PATCH", `/v1/designs/${teamDesign}`, { name: "Pricing, tighter" });
    await t.backgroundDone();
    expect((await getLiveSandbox(t.db, teamDesign))?.state).toBe("awake");

    // Her Scratch design, and one in her own account's workspace.
    scratchDesign = (await designIn(t, ws, "rae", sampleDoc(), "scratch")).id;
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
    ownDesign = (
      await createDesign(t.db, {
        workspaceId: own.id,
        repoId: null,
        ownerId: rae.userId,
        claudeAccountId: null,
        name: "Mine",
        branch: null,
        doc: sampleDoc(),
      })
    ).id;
    // A teammate's design, which is not hers to delete.
    solsDesign = (await designIn(t, ws, "sol", sampleDoc())).id;

    await recordUsage(t.db, {
      id: "rae-usage",
      workspaceId: ws.id,
      designId: teamDesign,
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

  test("deletes her Scratch designs and those in her own account", async () => {
    expect(await getDesign(t.db, scratchDesign)).toBeNull();
    expect(await getDesign(t.db, ownDesign)).toBeNull();
  });

  test("keeps the team's design, owned by nobody, its sandbox retired", async () => {
    const design = await getDesign(t.db, teamDesign);
    expect(design?.ownerId).toBeNull();
    expect(await getLiveSandbox(t.db, teamDesign)).toBeNull();
    expect(
      (await t.sandbox.list({ labels: { design: teamDesign } })).filter((s) => s.state !== "gone"),
    ).toEqual([]);
    expect((await getDesign(t.db, solsDesign))?.ownerId).not.toBeNull();
  });

  test("keeps her words in the team's design, under a deleted user's name", async () => {
    const sol = await as("sol");
    const thread = await call(t, sol, "GET", `/v1/designs/${teamDesign}/thread`);
    expect(thread.status).toBe(200);
    const message = thread.body.items.find((item: { kind: string }) => item.kind === "message");
    expect(message.payload).toMatchObject({
      text: "Tighten the pricing table",
      from: { name: "Deleted user", login: "ghost" },
    });
    const ops = await rows(
      `select actor_name, actor_avatar_url from design_ops
        where design_id = '${teamDesign}' and actor_id = '${rae.userId}'`,
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

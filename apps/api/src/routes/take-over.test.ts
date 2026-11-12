import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { getCanvas, takeOverCanvas } from "@ponzu/db";
import { canvasSandboxName } from "@ponzu/sandbox";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_SCOPE, type TestApp } from "../testing/index.ts";

/*
 * POST /v1/canvases/:id/take-over (docs/cloud.md, "Deleting an account"): a canvas whose owner
 * left the workspace, or deleted their account, becomes a teammate's, on their Claude, with
 * every refusal and the races the statement settles.
 */

let t: TestApp;
let ws: Workspace;
// Bryce owns the canvases and leaves; Maya and Ines can change them; Omar can only read them.
const KEYS: Record<string, string> = {
  bryce: "sk-ant-api03-bryce-own-key-00000000000",
  maya: "sk-ant-api03-maya-own-key-000000000000",
  ines: "sk-ant-api03-ines-own-key-000000000000",
  omar: "sk-ant-api03-omar-own-key-000000000000",
};

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, {
    ada: "admin",
    bryce: "write",
    maya: "write",
    ines: "write",
    omar: "read",
    noor: "write",
  });
  for (const login of ["bryce", "maya", "ines", "omar"]) await connectKey(login, KEYS[login]!);
});
afterAll(() => t.close());

/** A fresh sign-in: the test clock may run past an access token's five minutes. */
const as = async (login: string) => (await t.signInAs({ login })).headers;
const idOf = (login: string) => ws.people[login]!.userId;
const takeOver = async (canvasId: string, login: string) =>
  call(t, await as(login), "POST", `/v1/canvases/${canvasId}/take-over`);
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;
const starts = (canvasId: string) =>
  t.sandboxes.commands(canvasSandboxName(TEST_SCOPE, canvasId)).filter((c) => c.kind === "start");

async function connectKey(login: string, key: string) {
  t.anthropic.keys.add(key);
  const connected = await call(t, await as(login), "POST", "/v1/claude/api-key", { key });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
}

async function sql(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

/** Bryce's canvas in the repo, as a fresh one. */
const bryces = () => canvasIn(t, ws, "bryce", sampleDoc());

/** Bryce leaves the workspace; he is a member again with `bryceRejoins`, and after each test. */
async function bryceLeaves() {
  await sql(
    `delete from memberships where user_id = '${idOf("bryce")}' and workspace_id = '${ws.id}'`,
  );
}
async function bryceRejoins() {
  await sql(
    `insert into memberships (workspace_id, user_id, role)
     values ('${ws.id}', '${idOf("bryce")}', 'member') on conflict do nothing`,
  );
}
afterEach(bryceRejoins);

/** What a teammate says to the agent, and everything it set going. */
async function say(canvasId: string, who: string, text = "Make the hero calmer") {
  const said = await call(t, await as(who), "POST", `/v1/canvases/${canvasId}/messages`, { text });
  expect(said.status).toBe(201);
  await t.backgroundDone();
}

async function thread(canvasId: string, who = "maya") {
  const read = await call(t, await as(who), "GET", `/v1/canvases/${canvasId}/thread`);
  expect(read.status).toBe(200);
  return read.body.items as { id: string; kind: string; payload: Record<string, unknown> }[];
}

const ownerChanged = async (canvasId: string) =>
  (await thread(canvasId)).filter(
    (item) => item.kind === "notice" && item.payload.type === "owner_changed",
  );

describe("POST /v1/canvases/:id/take-over", () => {
  test("a canvas whose owner left becomes the taker's, on their Claude, and wakes with what waited", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    // Maya speaks to it after he left: the wake finds its owner gone, and it waits.
    await say(canvas.id, "maya");
    expect((await head(canvas.id)).agentBlocker).toBe("claude_owner_left");
    expect(starts(canvas.id)).toHaveLength(0);

    const taken = await takeOver(canvas.id, "maya");
    await t.backgroundDone();

    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ id: canvas.id, ownerId: idOf("maya"), agentBlocker: null });
    const row = await head(canvas.id);
    const [account] = await sql(`select id from claude_accounts where user_id = '${idOf("maya")}'`);
    expect(row).toMatchObject({ ownerId: idOf("maya"), claudeAccountId: account!.id });
    // The thread says so, under an id no runner can write.
    const notices = await ownerChanged(canvas.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toMatch(/^ti_owner-[A-Za-z0-9]{16}$/);
    expect(notices[0]!.payload).toEqual({
      type: "owner_changed",
      by: { id: idOf("maya"), name: expect.any(String), login: "maya" },
    });
    // Her message waited in the feed, so the canvas woke, on her key and nobody else's.
    expect(starts(canvas.id)).toHaveLength(1);
    expect(starts(canvas.id)[0]!.command.env!.ANTHROPIC_API_KEY).toBe(KEYS.maya);
    const captured = t.analytics
      .of("canvas taken over")
      .findLast((e) => e.properties.canvas_id === canvas.id);
    expect(captured?.properties).toMatchObject({ canvas_id: canvas.id, woke: true });
  });

  test("a canvas whose owner deleted their account can be taken over, and with nothing owed it stays asleep", async () => {
    const canvas = await bryces();
    // What account deletion leaves of a kept canvas: no owner, the account it ran on gone.
    await sql(
      `update canvases set owner_id = null, claude_account_id = null where id = '${canvas.id}'`,
    );

    const taken = await takeOver(canvas.id, "ines");
    await t.backgroundDone();

    expect(taken.status).toBe(200);
    expect(taken.body.ownerId).toBe(idOf("ines"));
    expect(await ownerChanged(canvas.id)).toHaveLength(1);
    expect(starts(canvas.id)).toHaveLength(0);
    expect(
      t.analytics.of("canvas taken over").findLast((e) => e.properties.canvas_id === canvas.id)
        ?.properties,
    ).toMatchObject({ canvas_id: canvas.id, woke: false });
  });

  test("refused 409 not_ownerless while its owner is in the workspace, to an admin too, with nothing changed", async () => {
    const canvas = await bryces();
    for (const login of ["maya", "ada"]) {
      const refused = await takeOver(canvas.id, login);
      expect([refused.status, refused.body.error.code]).toEqual([409, "not_ownerless"]);
    }
    expect(await head(canvas.id)).toMatchObject({ ownerId: idOf("bryce"), claudeAccountId: null });
    expect(await ownerChanged(canvas.id)).toHaveLength(0);
  });

  test("refused 409 claude_not_connected to a writer with no Claude, or one whose sign-in ran out", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    const none = await takeOver(canvas.id, "noor");
    expect([none.status, none.body.error.code]).toEqual([409, "claude_not_connected"]);

    await sql(
      `update claude_accounts set expires_at = '2000-01-01T00:00:00Z' where user_id = '${idOf("ines")}'`,
    );
    const expired = await takeOver(canvas.id, "ines");
    expect([expired.status, expired.body.error.code]).toEqual([409, "claude_not_connected"]);
    await sql(`update claude_accounts set expires_at = null where user_id = '${idOf("ines")}'`);

    expect((await head(canvas.id)).ownerId).toBe(idOf("bryce"));
    expect(await ownerChanged(canvas.id)).toHaveLength(0);
  });

  test("someone who can only read it is forbidden, and someone outside the workspace finds nothing", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    const reader = await takeOver(canvas.id, "omar");
    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    const stranger = await call(
      t,
      (await t.signInAs({ login: "stranger" })).headers,
      "POST",
      `/v1/canvases/${canvas.id}/take-over`,
    );
    expect(stranger.status).toBe(404);
    expect((await head(canvas.id)).ownerId).toBe(idOf("bryce"));
  });

  test("a wait on anything but Claude stays: taking over is not a way past billing", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    await sql(`update canvases set agent_blocker = 'cap_reached' where id = '${canvas.id}'`);
    const taken = await takeOver(canvas.id, "maya");
    expect(taken.status).toBe(200);
    expect((await head(canvas.id)).agentBlocker).toBe("cap_reached");
  });

  test("two teammates at once: one takes it, the other is refused, and the thread says it once", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    const [first, second] = await Promise.all([
      takeOver(canvas.id, "maya"),
      takeOver(canvas.id, "ines"),
    ]);
    const statuses = [first.status, second.status].toSorted();
    expect(statuses).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body.error.code).toBe("not_ownerless");
    const winner = first.status === 200 ? "maya" : "ines";
    expect((await head(canvas.id)).ownerId).toBe(idOf(winner));
    expect(await ownerChanged(canvas.id)).toHaveLength(1);
  });

  test("the owner coming back wins: refused, and the stale wait is lifted so it runs on theirs", async () => {
    const canvas = await bryces();
    await bryceLeaves();
    await say(canvas.id, "maya");
    expect((await head(canvas.id)).agentBlocker).toBe("claude_owner_left");
    // He is back before Maya's press reaches the API.
    await bryceRejoins();
    const refused = await takeOver(canvas.id, "maya");
    await t.backgroundDone();

    expect([refused.status, refused.body.error.code]).toEqual([409, "not_ownerless"]);
    expect(await head(canvas.id)).toMatchObject({ ownerId: idOf("bryce"), agentBlocker: null });
    expect(await ownerChanged(canvas.id)).toHaveLength(0);
    // Maya's message was owed, so it woke on Bryce's Claude.
    expect(starts(canvas.id)).toHaveLength(1);
    expect(starts(canvas.id)[0]!.command.env!.ANTHROPIC_API_KEY).toBe(KEYS.bryce);
  });

  test("the statement holds on the owner being gone as it runs, not as the route first read it", async () => {
    const canvas = await bryces();
    // What the statement itself decides, whatever the route read before it: Bryce is here.
    const now = new Date(t.clock.now());
    const noticeId = "ti_owner-race0000000000000";
    const notice = { type: "owner_changed", by: { id: idOf("maya"), name: "Maya", login: "maya" } };
    expect(
      await takeOverCanvas(t.db, {
        canvasId: canvas.id,
        userId: idOf("maya"),
        noticeId,
        notice,
        now,
      }),
    ).toEqual({ outcome: "not_ownerless", lifted: false, pending: false });
    await bryceLeaves();
    expect(
      await takeOverCanvas(t.db, {
        canvasId: canvas.id,
        userId: idOf("maya"),
        noticeId,
        notice,
        now,
      }),
    ).toEqual({ outcome: "taken", pending: false });
    // A second go finds Maya the owner, and a member.
    expect(
      await takeOverCanvas(t.db, {
        canvasId: canvas.id,
        userId: idOf("ines"),
        noticeId,
        notice,
        now,
      }),
    ).toEqual({ outcome: "not_ownerless", lifted: false, pending: false });
    expect(
      await takeOverCanvas(t.db, {
        canvasId: "cnv_none",
        userId: idOf("maya"),
        noticeId,
        notice,
        now,
      }),
    ).toBeNull();
  });
});

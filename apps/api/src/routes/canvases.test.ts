import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  appendThreadItem,
  focusedPresence,
  getCanvasAssetKey,
  insertNotifications,
  type NewNotification,
  notifications,
  readDocSource,
} from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import {
  call,
  canvasIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  // An admin, a writer, a reader, and a member GitHub gives nothing in the repository.
  ws = await workspaceWithRepo(t, { ada: "admin", maya: "write", ines: "read", omar: "none" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const nobody = async () => (await t.signInAs({ login: "stranger" })).headers;

describe("POST /v1/canvases", () => {
  test("starts a canvas in a repo the person can push to: seq 0, one empty page", async () => {
    const { status, body } = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
      name: "Checkout",
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      workspaceId: ws.id,
      repo: { id: ws.repo.id, fullName: ws.repo.fullName },
      ownerId: ws.people.maya!.userId,
      name: "Checkout",
      status: "active",
      seq: 0,
      agentState: "idle",
      access: "write",
    });
    const assetKey = await getCanvasAssetKey(t.db, body.id);
    expect(body.assetsUrl).toBe(`https://assets.test/${assetKey}/`);
    const source = await readDocSource(t.db, body.id);
    expect(source!.checkpoint.doc).toMatchObject({ name: "Checkout", threads: [], notes: {} });
    expect(source!.checkpoint.doc.pages).toEqual([
      { id: expect.stringMatching(/^pg_/), name: "Page 1", artboards: [] },
    ]);
  });

  test("Scratch needs only membership, and is named for you when you don't", async () => {
    const { status, body } = await call(t, as("omar"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ repo: null, name: "Untitled", access: "write" });
  });

  test("a repo the person can only read is forbidden; one they cannot see is not there", async () => {
    const create = (login: string) =>
      call(t, as(login), "POST", "/v1/canvases", { workspaceId: ws.id, repoId: ws.repo.id });

    expect((await create("ines")).status).toBe(403);
    expect((await create("omar")).status).toBe(404);
  });

  test("a workspace you are not in, or a repo from another one, is not there", async () => {
    const other = await workspaceWithRepo(t, { maya: "write" });

    const outsider = await call(t, await nobody(), "POST", "/v1/canvases", { workspaceId: ws.id });
    const elsewhere = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: other.repo.id,
    });

    expect([outsider.status, outsider.body.error.code]).toEqual([404, "not_found"]);
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([404, "not_found"]);
  });

  test("with a first message: its thread, its feed, a wake and a branch named for it, at once", async () => {
    const { status, body } = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
      message: { text: "Make the pricing page calmer, with a quieter hero" },
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "Untitled", branch: "pz/pricing-page-calmer" });
    const thread = await call(t, as("maya"), "GET", `/v1/canvases/${body.id}/thread`);
    expect(thread.body.items).toMatchObject([
      { kind: "message", payload: { text: "Make the pricing page calmer, with a quieter hero" } },
    ]);
    expect((await feedOf(t.db, body.id)).map((event) => [event.kind, event.priority])).toEqual([
      ["message", "now"],
    ]);
    const jobs = (await t.db.execute(
      `select kind from jobs where key = '${body.id}'`,
    )) as unknown as { rows: unknown[] };
    expect(jobs.rows).toEqual([{ kind: "sandbox.wake" }]);
    await t.backgroundDone();
    // Maya has no Claude connected here, so the canvas says what it waits for.
    expect((await call(t, as("maya"), "GET", `/v1/canvases/${body.id}`)).body.agentBlocker).toBe(
      "claude_not_connected",
    );
  });

  test("a branch already taken in the repo gets the next number; Scratch has none", async () => {
    const create = (repoId: string | null) =>
      call(t, as("maya"), "POST", "/v1/canvases", {
        workspaceId: ws.id,
        repoId,
        message: { text: "A darker footer" },
      });
    const [first, second] = [await create(ws.repo.id), await create(ws.repo.id)];
    const scratch = await create(null);
    expect([first.body.branch, second.body.branch]).toEqual([
      "pz/darker-footer",
      "pz/darker-footer-2",
    ]);
    expect(scratch.body.branch).toBeNull();
  });

  test("the same create key twice makes one canvas, however close together", async () => {
    const create = () =>
      call(t, as("maya"), "POST", "/v1/canvases", {
        workspaceId: ws.id,
        repoId: ws.repo.id,
        message: { text: "Onboarding, but kinder" },
        createKey: "composer-7f3a9c21",
      });
    const [one, two] = await Promise.all([create(), create()]);
    const three = await create();

    expect(new Set([one.body.id, two.body.id, three.body.id]).size).toBe(1);
    expect([one.status, two.status, three.status].sort()).toEqual([200, 200, 201]);
    expect(await feedOf(t.db, one.body.id)).toHaveLength(1);
  });

  test("a model and effort are taken, and the person's defaults fill in for them", async () => {
    const chosen = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    const defaulted = await call(t, as("maya"), "POST", "/v1/canvases", { workspaceId: ws.id });
    const bad = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      model: "gpt-9",
    });
    const session = async (id: string) =>
      (await call(t, await runnerHeaders(t, id), "POST", "/v1/runner/session", {})).body;
    expect(await session(chosen.body.id)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(await session(defaulted.body.id)).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, "model_not_offered"]);
  });

  test("a runner cannot start one", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Runner's"));
    const { status } = await call(t, await runnerHeaders(t, canvas.id), "POST", "/v1/canvases", {
      workspaceId: ws.id,
    });
    expect(status).toBe(401);
  });
});

describe("GET /v1/canvases/:id", () => {
  test("says what each person may do, and gives the files' address only to those who can open it", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Pricing"));
    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    const get = (headers: Record<string, string>) =>
      call(t, headers, "GET", `/v1/canvases/${canvas.id}`);

    const [writer, reader, outsider, member] = await Promise.all([
      get(as("maya")),
      get(as("ines")),
      get(await nobody()),
      get(as("omar")),
    ]);

    expect(writer.body).toMatchObject({ id: canvas.id, name: "Pricing", access: "write" });
    expect(reader.body).toMatchObject({ id: canvas.id, access: "read" });
    expect(reader.body.assetsUrl).toBe(`https://assets.test/${assetKey}/`);
    for (const refused of [outsider, member]) {
      expect([refused.status, refused.body.error.code]).toEqual([404, "not_found"]);
      expect(JSON.stringify(refused.body)).not.toContain(assetKey!);
    }
    expect((await get(as("maya"))).body).not.toHaveProperty("assetKey");
  });

  test("a Scratch canvas is its owner's alone, and one that does not exist looks the same", async () => {
    const scratch = await canvasIn(t, ws, "maya", emptyDoc("Mine"), "scratch");

    expect((await call(t, as("maya"), "GET", `/v1/canvases/${scratch.id}`)).body.access).toBe(
      "write",
    );
    const admin = await call(t, as("ada"), "GET", `/v1/canvases/${scratch.id}`);
    const missing = await call(t, as("maya"), "GET", "/v1/canvases/cnv_nothing");
    expect([admin.status, missing.status]).toEqual([404, 404]);
  });

  test("GitHub is asked once a minute per person and repo, so a revoked person is out within one", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Cached"));
    const ask = async () => (await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}`)).status;
    const asked = () => t.github.permissionRequests.filter((line) => line.endsWith(" ines")).length;
    expect(await ask()).toBe(200);
    const before = asked();

    ws.grant("ines", "none");
    t.clock.advance(59_000);
    expect(await ask()).toBe(200);
    expect(asked()).toBe(before);

    t.clock.advance(2_000);
    expect(await ask()).toBe(404);
    expect(asked()).toBe(before + 1);
    ws.grant("ines", "read");
    t.clock.advance(61_000);
  });

  test("the workspace's App gone means nobody can open its repo canvases", async () => {
    const other = await workspaceWithRepo(t, { maya: "write" });
    const canvas = await canvasIn(t, other, "maya", emptyDoc("Orphaned"));
    t.github.installations.splice(
      t.github.installations.findIndex(({ id }) => id === other.installationId),
      1,
    );

    expect((await call(t, as("maya"), "GET", `/v1/canvases/${canvas.id}`)).status).toBe(404);
  });
});

describe("PATCH /v1/canvases/:id", () => {
  test("renames, sets the icon, settles and reopens", async () => {
    const canvas = await canvasIn(t, ws, "ada", emptyDoc("Draft"));
    const patch = (body: unknown) =>
      call(t, as("maya"), "PATCH", `/v1/canvases/${canvas.id}`, body);

    expect((await patch({ name: "  Final  ", icon: "star" })).body).toMatchObject({
      name: "Final",
      icon: "star",
    });
    const settled = await patch({ settled: true });
    expect(settled.body).toMatchObject({ status: "settled", settledAt: expect.any(String) });
    expect((await patch({ settled: false, icon: null })).body).toMatchObject({
      status: "active",
      settledAt: null,
      icon: null,
    });
  });

  test("names the document, which is what every replica and the agent read, by an op in the log", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Draft"));

    await call(t, as("maya"), "PATCH", `/v1/canvases/${canvas.id}`, {
      name: "Final",
      icon: "star",
    });

    const { body } = await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/doc`);
    expect(body).toMatchObject({ doc: { name: "Final", icon: "star" }, seq: 1 });
    const ops = await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/ops?after=0`);
    expect(ops.body.ops).toMatchObject([
      { seq: 1, actor: { kind: "user", id: ws.people.maya!.userId } },
    ]);
    // The agent hears of it like any other edit.
    expect((await feedOf(t.db, canvas.id)).map((e) => e.kind)).toEqual(["edit"]);
    // Settling alone touches no document.
    await call(t, as("maya"), "PATCH", `/v1/canvases/${canvas.id}`, { settled: true });
    expect((await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/doc`)).body.seq).toBe(1);
  });

  test("the row follows whoever names the document, the agent included", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Untitled"));

    await call(t, await runnerHeaders(t, canvas.id), "POST", `/v1/canvases/${canvas.id}/ops`, {
      ops: [{ id: "op_name", op: { op: "file.rename", name: "Checkout flow" } }],
    });

    expect((await call(t, as("maya"), "GET", `/v1/canvases/${canvas.id}`)).body.name).toBe(
      "Checkout flow",
    );
    await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/undo`);
    expect((await call(t, as("maya"), "GET", `/v1/canvases/${canvas.id}`)).body.name).toBe(
      "Untitled",
    );
  });

  test("refuses a reader, an empty change and an icon Ponzu does not draw", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Kept"));
    const patch = (login: string, body: unknown) =>
      call(t, as(login), "PATCH", `/v1/canvases/${canvas.id}`, body);

    expect((await patch("ines", { name: "Mine now" })).status).toBe(403);
    expect((await patch("maya", {})).status).toBe(400);
    expect((await patch("maya", { icon: "rocket-ship-9000" })).status).toBe(400);
  });
});

describe("DELETE /v1/canvases/:id", () => {
  test("its owner or a workspace admin may, with everything that is its own; a reader may not", async () => {
    const [mine, theirs] = await Promise.all([
      canvasIn(t, ws, "maya", emptyDoc("Mine")),
      canvasIn(t, ws, "maya", emptyDoc("Also mine")),
    ]);
    const remove = (login: string, id: string) =>
      call(t, as(login), "DELETE", `/v1/canvases/${id}`);

    expect((await remove("ines", mine.id)).status).toBe(403);
    expect((await remove("omar", mine.id)).status).toBe(404);
    expect((await remove("maya", mine.id)).status).toBe(204);
    expect((await remove("ada", theirs.id)).status).toBe(204);
    expect(await readDocSource(t.db, theirs.id)).toBeNull();
  });

  test("a writer who neither owns it nor runs the workspace is forbidden", async () => {
    const team = await workspaceWithRepo(t, { lead: "admin", sam: "write", kim: "write" });
    const canvas = await canvasIn(t, team, "sam", emptyDoc("Sam's"));

    const refused = await call(t, team.people.kim!.headers, "DELETE", `/v1/canvases/${canvas.id}`);

    expect([refused.status, refused.body.error.code]).toEqual([403, "forbidden"]);
  });
});

describe("GET /v1/canvases/:id/doc", () => {
  test("anyone who can open it, and its runner, read the document; another canvas's runner cannot", async () => {
    const [canvas, other] = await Promise.all([
      canvasIn(t, ws, "maya", emptyDoc("Read me")),
      canvasIn(t, ws, "maya", emptyDoc("Not yours")),
    ]);
    const runner = await runnerHeaders(t, canvas.id);

    const reader = await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/doc`);
    const own = await call(t, runner, "GET", `/v1/canvases/${canvas.id}/doc`);
    const elsewhere = await call(t, runner, "GET", `/v1/canvases/${other.id}/doc`);

    expect(reader.body).toEqual({ doc: emptyDoc("Read me"), seq: 0 });
    expect(own.body).toEqual(reader.body);
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([404, "not_found"]);
  });
});

describe("GET /v1/canvases/:id/ops", () => {
  test("pages by size as well as count, so catching up after big edits fits in an answer", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Heavy"));
    const runner = await runnerHeaders(t, canvas.id);
    // Two posts as large as the replica sends: 12 notes of 250 KB each.
    for (const post of [1, 2]) {
      const ops = Array.from({ length: 12 }, (_, i) => ({
        id: `op_${post}_${i}`,
        op: { op: "note", name: `n${i}`, content: "x".repeat(250_000) },
      }));
      expect((await call(t, runner, "POST", `/v1/canvases/${canvas.id}/ops`, { ops })).status).toBe(
        200,
      );
    }

    const pages: number[][] = [];
    for (let after = 0; after < 24; ) {
      const response = await t.app.request(`/v1/canvases/${canvas.id}/ops?after=${after}`, {
        headers: as("ines"),
      });
      const text = await response.text();
      // What a Vercel function may send.
      expect(text.length).toBeLessThan(4_500_000);
      const { ops, seq } = JSON.parse(text);
      expect(seq).toBe(24);
      pages.push(ops.map((op: { seq: number }) => op.seq));
      after = ops.at(-1).seq;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });
});

describe("presence", () => {
  test("says who is here, follows them between pages, and forgets them 75 seconds after their last word", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Busy"));
    const here = (login: string, body: unknown = {}) =>
      call(t, as(login), "PUT", `/v1/canvases/${canvas.id}/presence`, body);

    await here("maya", { pageId: "pg_1" });
    t.clock.advance(30_000);
    const both = await here("ines");
    expect(both.body.present.map((p: any) => [p.githubLogin, p.pageId])).toEqual([
      ["maya", "pg_1"],
      ["ines", null],
    ]);
    expect(both.body.present[0]).toMatchObject({ name: "Maya", avatarUrl: expect.any(String) });

    // Maya stops refreshing. 75 seconds after her last word she is gone; Ines stays.
    t.clock.advance(46_000);
    const after = await here("ines", { pageId: "pg_2" });
    expect(after.body.present.map((p: any) => [p.githubLogin, p.pageId])).toEqual([
      ["ines", "pg_2"],
    ]);
  });

  test("leaving takes a person out at once; someone who cannot open it cannot be here", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Quiet"));
    await call(t, as("maya"), "PUT", `/v1/canvases/${canvas.id}/presence`, {});

    expect((await call(t, as("maya"), "DELETE", `/v1/canvases/${canvas.id}/presence`)).status).toBe(
      204,
    );
    const left = await call(t, as("ines"), "PUT", `/v1/canvases/${canvas.id}/presence`, {});
    expect(left.body.present.map((p: any) => p.githubLogin)).toEqual(["ines"]);
    expect(
      (await call(t, as("omar"), "PUT", `/v1/canvases/${canvas.id}/presence`, {})).status,
    ).toBe(404);
    expect(
      (await call(t, as("ines"), "PUT", `/v1/canvases/${canvas.id}/presence`, { focused: "yes" }))
        .status,
    ).toBe(400);
    // Leaving one that is gone (just deleted, say) is quiet.
    expect((await call(t, as("maya"), "DELETE", "/v1/canvases/cnv_gone/presence")).status).toBe(
      204,
    );
  });
});

describe("presence focus", () => {
  test("says whether the person is looking at the canvas, kept until they say otherwise", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Watched"));
    const maya = ws.people.maya!.userId;
    const here = (body: unknown) =>
      call(t, as("maya"), "PUT", `/v1/canvases/${canvas.id}/presence`, body);
    const looking = async () =>
      (
        await focusedPresence(t.db, {
          canvasId: canvas.id,
          userIds: [maya],
          now: new Date(t.clock.now()),
        })
      ).get(maya) ?? null;

    // Opened, with nothing said of focus: not looking.
    await here({ pageId: "pg_1" });
    expect(await looking()).toBeNull();

    t.clock.advance(1_000);
    const focusedAt = new Date(t.clock.now());
    expect((await here({ focused: true })).status).toBe(200);
    expect(await looking()).toEqual(focusedAt);

    // A beat that says nothing of focus keeps it as it was, and the page stays.
    t.clock.advance(30_000);
    const still = await here({});
    expect(still.body.present.map((p: any) => p.pageId)).toEqual(["pg_1"]);
    expect(await looking()).toEqual(focusedAt);

    // The window lost focus.
    t.clock.advance(1_000);
    await here({ focused: false });
    expect(await looking()).toBeNull();
    // Focused again, then gone quiet for 75 seconds: no longer here, so not looking.
    await here({ focused: true });
    t.clock.advance(76_000);
    expect(await looking()).toBeNull();
  });
});

describe("seen", () => {
  test("reads what Ponzu told the person about the canvas until now, and nothing else", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Told"));
    const other = await canvasIn(t, ws, "maya", emptyDoc("Elsewhere"));
    const [ines, maya] = [ws.people.ines!.userId, ws.people.maya!.userId];
    const told = (userId: string, canvasId: string, n: string): NewNotification => ({
      id: `ntf_seen_${n}`,
      userId,
      workspaceId: ws.id,
      canvasId,
      kind: "reply",
      dedupeKey: `reply:${canvasId}:${n}`,
      title: "Told",
      body: "Ponzu replied to your comment.",
      link: { open: "thread" },
      muted: false,
    });
    await insertNotifications(t.db, {
      now: new Date(t.clock.now()),
      rows: [
        told(ines, canvas.id, "here"),
        told(ines, other.id, "there"),
        told(maya, canvas.id, "hers"),
      ],
    });
    const readVia = async (id: string) =>
      (await t.db.select().from(notifications)).find((row) => row.id === id)!.readVia;

    t.clock.advance(1_000);
    expect((await call(t, as("ines"), "POST", `/v1/canvases/${canvas.id}/seen`, {})).status).toBe(
      204,
    );

    expect(await readVia("ntf_seen_here")).toBe("seen");
    expect(await readVia("ntf_seen_there")).toBeNull();
    expect(await readVia("ntf_seen_hers")).toBeNull();
    // Someone who cannot open the canvas reads nothing through it.
    expect((await call(t, as("omar"), "POST", `/v1/canvases/${canvas.id}/seen`, {})).status).toBe(
      404,
    );
  });

  test("records how far a person has looked, never past the canvas and never backwards", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Dot"));
    const runner = await runnerHeaders(t, canvas.id);
    await call(t, runner, "POST", `/v1/canvases/${canvas.id}/ops`, {
      ops: [{ id: "op_seen_1", op: { op: "note", name: "a", content: "1" } }],
    });
    const seen = (body: unknown) =>
      call(t, as("ines"), "POST", `/v1/canvases/${canvas.id}/seen`, body);
    const row = async () =>
      (await call(t, as("ines"), "GET", `/v1/workspaces/${ws.id}/canvases`)).body.canvases.find(
        (d: any) => d.id === canvas.id,
      );

    const item = await appendThreadItem(t.db, {
      canvasId: canvas.id,
      kind: "assistant",
      payload: { text: "Done." },
    });

    expect((await seen({ seq: 40, threadSeq: 9e15 })).status).toBe(204);
    expect(await row()).toMatchObject({ seenSeq: 1, seenThreadSeq: item!.seq });
    await seen({ seq: 0 });
    expect(await row()).toMatchObject({ seenSeq: 1 });

    // A number from a buggy client cannot hide the dot for what comes next.
    const next = await appendThreadItem(t.db, {
      canvasId: canvas.id,
      kind: "assistant",
      payload: { text: "Again." },
    });
    expect(await row()).toMatchObject({ seenThreadSeq: item!.seq });
    await seen({ threadSeq: next!.seq });
    expect(await row()).toMatchObject({ seenThreadSeq: next!.seq });
  });
});

describe("GET /v1/workspaces/:id/canvases", () => {
  test("lists the workspace's canvases to a member, Scratch only to its owner", async () => {
    const team = await workspaceWithRepo(t, { lead: "admin", sam: "write" });
    const [shared, scratch] = await Promise.all([
      canvasIn(t, team, "lead", emptyDoc("Shared")),
      canvasIn(t, team, "lead", emptyDoc("Lead's scratch"), "scratch"),
    ]);
    const list = async (headers: Record<string, string>) =>
      call(t, headers, "GET", `/v1/workspaces/${team.id}/canvases`);

    const lead = await list(team.people.lead!.headers);
    const sam = await list(team.people.sam!.headers);
    const outsider = await list(await nobody());

    expect(lead.body.canvases.map((d: any) => d.id).sort()).toEqual([shared.id, scratch.id].sort());
    expect(sam.body.canvases.map((d: any) => d.id)).toEqual([shared.id]);
    expect(sam.body.canvases[0]).toMatchObject({
      name: "Shared",
      repoFullName: team.repo.fullName,
      seq: 0,
      seenSeq: null,
    });
    expect(sam.body.canvases[0]).not.toHaveProperty("assetKey");
    expect(outsider.status).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq, sql } from "drizzle-orm";
import { actorFor, rename, seedCanvas, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { CANVAS_HEAD_COLUMNS, type LiveCanvasHead, toCanvasHead } from "../head.ts";
import { canvases, canvasReads } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { markReposRemoved, upsertMembership } from "./accounts.ts";
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  getCanvasAccess,
  getCanvasAssetKey,
  getCanvasHead,
  getWorkspaceRepo,
  head as headColumns,
  listWorkspaceCanvases,
  markCanvasSeen,
  settleCanvas,
} from "./canvases.ts";
import { readDocSource } from "./checkpoints.ts";
import { commitOps } from "./ops.ts";
import { recordRepoAccess } from "./repo-access.ts";
import { appendThreadItem } from "./thread.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

describe("createCanvas", () => {
  test("makes the canvas and its first checkpoint together", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id);
    const doc = { ...emptyDoc("Shorter onboarding"), tokens: ":root {\n  --ink: #111;\n}\n" };

    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Shorter onboarding",
      branch: "pz/shorter-onboarding",
      model: "claude-opus",
      effort: "high",
      doc,
    });

    expect(canvas.id).toMatch(/^cnv_[0-9a-z]{16}$/);
    expect(canvas).toMatchObject({
      status: "active",
      seq: 0,
      agentState: "idle",
      agentArtboards: [],
      needsYouCount: 0,
      prNumber: null,
      prChecks: "none",
    });
    expect(await getCanvas(db, canvas.id)).toEqual(canvas);
    expect(await readDocSource(db, canvas.id)).toEqual({
      seq: 0,
      checkpoint: { seq: 0, doc },
      ops: [],
    });
  });

  test("gives every canvas its own unguessable asset key", async () => {
    const [one, two] = await Promise.all([seedCanvas(db), seedCanvas(db)]);
    const [oneKey, twoKey] = await Promise.all([
      getCanvasAssetKey(db, one.canvas.id),
      getCanvasAssetKey(db, two.canvas.id),
    ]);
    expect(oneKey).toMatch(/^[0-9a-z]{32}$/);
    expect(oneKey).not.toBe(twoKey);
    expect(await getCanvasAssetKey(db, "cnv_missing")).toBeNull();
  });

  test("leaves nothing behind when the canvas cannot be made", async () => {
    const user = await seedUser(db);
    const before = await db.$count(canvases);

    const refused = createCanvas(db, {
      workspaceId: "ws_missing",
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Orphan",
      branch: null,
      doc: emptyDoc("Orphan"),
    });

    await expect(refused).rejects.toThrow();
    expect(await db.$count(canvases)).toBe(before);
  });

  test("refuses a repo that is not the workspace's", async () => {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, elsewhere.id);

    const refused = createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Misfiled",
      branch: "pz/misfiled",
      doc: emptyDoc("Misfiled"),
    });

    await expect(refused).rejects.toThrow("canvases_repo_id_workspace_id_fk");
  });

  test("refuses a document Postgres cannot store, before it sends anything", async () => {
    const { user, workspace } = await seedCanvas(db);

    const refused = createCanvas(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Broken",
      branch: null,
      doc: emptyDoc("half a pair \ud83d"),
    });

    await expect(refused).rejects.toThrow("cannot store");
  });
});

describe("getCanvas", () => {
  test("is the row without its asset key, which has to be asked for by name", async () => {
    const { canvas } = await seedCanvas(db);

    const row = await getCanvas(db, canvas.id);

    expect(row).toMatchObject({ id: canvas.id, name: "Lisbon" });
    expect(row).not.toHaveProperty("assetKey");
    expect(canvas).not.toHaveProperty("assetKey");
  });
});

describe("getCanvasHead", () => {
  test("is the small part of the row that clients watch", async () => {
    const { canvas, user } = await seedCanvas(db);
    await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });

    const head = await getCanvasHead(db, canvas.id);

    expect(head).toMatchObject({ id: canvas.id, workspaceId: canvas.workspaceId, seq: 1 });
    // Whatever joins this list is re-sent to every watcher on every op. Nothing secret, nothing large.
    expect(Object.keys(head!).sort()).toEqual([
      "agentArtboards",
      "agentState",
      "agentStatus",
      // When its file links were last reset, never the key itself.
      "assetKeyRotatedAt",
      "icon",
      "id",
      "lastActivityAt",
      "name",
      "needsYouCount",
      "prAutoMerge",
      "prChecks",
      "prLinkedCount",
      "prLinkedOpen",
      "prMergeable",
      "prNumber",
      "prState",
      "previewSeq",
      "seq",
      "status",
      "workspaceId",
    ]);
  });

  test("is null for a canvas that does not exist", async () => {
    expect(await getCanvasHead(db, "cnv_missing")).toBeNull();
    expect(await getCanvas(db, "cnv_missing")).toBeNull();
  });

  test("a live query's columns are the head's, by their own names", () => {
    expect<string[]>([...CANVAS_HEAD_COLUMNS]).toEqual(
      Object.values(headColumns).map((column) => column.name),
    );
  });

  test("a row as Realtime delivers it decodes to the same head", async () => {
    const { canvas, user } = await seedCanvas(db);
    await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: Array.from({ length: 10 }, (_, i) => rename(`op-${i}`, `v${i}`)),
    });
    await db.update(canvases).set({ previewSeq: 9 }).where(eq(canvases.id, canvas.id));
    // What the Realtime SDK hands over: keys are column names, a bigint is a string.
    const { rows } = await db.execute<LiveCanvasHead>(sql`
      select ${sql.raw(CANVAS_HEAD_COLUMNS.join(", "))} from canvases where id = ${canvas.id}
    `);
    const live = { ...rows[0]!, seq: "10", preview_seq: "9" };

    const decoded = toCanvasHead(live);

    expect(decoded).toEqual((await getCanvasHead(db, canvas.id))!);
    expect(decoded.seq).toBe(10);
    expect(decoded.previewSeq).toBe(9);
    expect(toCanvasHead({ ...live, preview_seq: null }).previewSeq).toBeNull();
  });
});

describe("listWorkspaceCanvases", () => {
  async function workspaceWithCanvases() {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, workspace.id);
    const make = (workspaceId: string, name: string, repoId: string | null) =>
      createCanvas(db, {
        workspaceId,
        repoId,
        ownerId: user.id,
        claudeAccountId: null,
        name,
        branch: repoId ? `pz/${name.toLowerCase()}` : null,
        doc: emptyDoc(name),
      });
    const oldest = await make(workspace.id, "Oldest", repo.id);
    const settled = await make(workspace.id, "Settled", null);
    const newest = await make(workspace.id, "Newest", null);
    await make(elsewhere.id, "Elsewhere", null);
    const at = (id: string, time: string) =>
      db
        .update(canvases)
        .set({ lastActivityAt: new Date(time) })
        .where(eq(canvases.id, id));
    await at(oldest.id, "2026-11-01T00:00:00Z");
    await at(settled.id, "2026-11-02T00:00:00Z");
    await at(newest.id, "2026-11-03T00:00:00Z");
    await db
      .update(canvases)
      .set({ status: "settled", settledAt: new Date() })
      .where(eq(canvases.id, settled.id));
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo.id, permission: "read", checkedAt: new Date() },
    ]);
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });
    return { user, workspace, repo, oldest, settled, newest };
  }

  const join = (workspaceId: string, ...users: { id: string }[]) =>
    Promise.all(
      users.map((user) => upsertMembership(db, { workspaceId, userId: user.id, role: "member" })),
    );

  test("lists nothing to someone who is not a member, whatever repo_access says", async () => {
    const { user, workspace, repo } = await workspaceWithCanvases();
    const outsider = await seedUser(db, "zoe");
    await recordRepoAccess(db, [
      { userId: outsider.id, repoId: repo.id, permission: "admin", checkedAt: new Date() },
    ]);
    const names = async (userId: string) =>
      (await listWorkspaceCanvases(db, { workspaceId: workspace.id, userId })).map((d) => d.name);

    expect(await names(outsider.id)).toEqual([]);
    await join(workspace.id, outsider);
    expect(await names(outsider.id)).toEqual(["Oldest"]);
    // The owner of Scratch canvases sees none of them once they have left.
    await db.execute(
      sql`delete from memberships where workspace_id = ${workspace.id} and user_id = ${user.id}`,
    );
    expect(await names(user.id)).toEqual([]);
  });

  test("lists one workspace's canvases, most recently active first", async () => {
    const { user, workspace } = await workspaceWithCanvases();

    const all = await listWorkspaceCanvases(db, { workspaceId: workspace.id, userId: user.id });

    expect(all.map((canvas) => canvas.name)).toEqual(["Newest", "Settled", "Oldest"]);
    expect(all.map((canvas) => canvas.repoFullName)).toEqual([null, null, "north-brook/fernwood"]);
  });

  test("lists what a sidebar row shows, and no asset key or sandbox", async () => {
    const { user, workspace, oldest } = await workspaceWithCanvases();

    const all = await listWorkspaceCanvases(db, { workspaceId: workspace.id, userId: user.id });

    const row = all.find((canvas) => canvas.id === oldest.id)!;
    expect(row).toMatchObject({
      ...(await getCanvasHead(db, oldest.id))!,
      repoId: oldest.repoId,
      ownerId: user.id,
      branch: "pz/oldest",
      settledAt: null,
    });
    // One `c.json(canvases)` must not hand every canvas's files to everyone in the workspace.
    for (const canvas of all) {
      expect(canvas).not.toHaveProperty("assetKey");
      expect(canvas).not.toHaveProperty("sandboxId");
    }
  });

  test("filters by status", async () => {
    const { user, workspace } = await workspaceWithCanvases();
    const list = (status: "active" | "settled") =>
      listWorkspaceCanvases(db, { workspaceId: workspace.id, userId: user.id, status });

    expect((await list("active")).map((canvas) => canvas.name)).toEqual(["Newest", "Oldest"]);
    expect((await list("settled")).map((canvas) => canvas.name)).toEqual(["Settled"]);
  });

  test("says how far the viewer has looked, and only the viewer", async () => {
    const { user, workspace, newest, oldest } = await workspaceWithCanvases();
    const teammate = await seedUser(db, "maya");
    await db.update(canvases).set({ seq: 4 }).where(eq(canvases.id, newest.id));
    const item = await appendThreadItem(db, {
      canvasId: newest.id,
      kind: "message",
      payload: { text: "Hi" },
    });
    await markCanvasSeen(db, {
      userId: user.id,
      canvasId: newest.id,
      seq: 4,
      threadSeq: item!.seq,
    });
    await markCanvasSeen(db, { userId: teammate.id, canvasId: oldest.id, seq: 2 });

    const mine = await listWorkspaceCanvases(db, { workspaceId: workspace.id, userId: user.id });

    expect(mine.map((d) => [d.name, d.seenSeq, d.seenThreadSeq])).toEqual([
      ["Newest", 4, item!.seq],
      ["Settled", null, null],
      ["Oldest", null, null],
    ]);
  });

  test("lists a repo's canvases to whoever repo_access says can read it, and Scratch to its owner only", async () => {
    const { workspace, repo } = await workspaceWithCanvases();
    const [reader, writer, revoked, unasked] = await Promise.all([
      seedUser(db, "ines"),
      seedUser(db, "ada"),
      seedUser(db, "omar"),
      seedUser(db, "lee"),
    ]);
    const checkedAt = new Date();
    await recordRepoAccess(db, [
      { userId: reader.id, repoId: repo.id, permission: "read", checkedAt },
      { userId: writer.id, repoId: repo.id, permission: "admin", checkedAt },
      { userId: revoked.id, repoId: repo.id, permission: "none", checkedAt },
    ]);
    await join(workspace.id, reader, writer, revoked, unasked);
    const names = async (userId: string) =>
      (await listWorkspaceCanvases(db, { workspaceId: workspace.id, userId })).map((d) => d.name);

    expect(await names(reader.id)).toEqual(["Oldest"]);
    expect(await names(writer.id)).toEqual(["Oldest"]);
    expect(await names(revoked.id)).toEqual([]);
    expect(await names(unasked.id)).toEqual([]);
  });
});

describe("getCanvasAccess", () => {
  test("a canvas in a repo comes with the repo's GitHub id and name, and the installation", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, "north-brook/harbor");
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Harbor",
      branch: "pz/harbor",
      doc: emptyDoc("Harbor"),
    });

    const access = await getCanvasAccess(db, { canvasId: canvas.id, userId: user.id });

    expect(access).toEqual({
      canvas: (await getCanvas(db, canvas.id))!,
      repo: { id: repo.id, githubRepoId: repo.githubRepoId, fullName: "north-brook/harbor" },
      installationId: workspace.installationId,
      suspendedAt: null,
      known: null,
      member: false,
    });
    expect(access!.canvas).not.toHaveProperty("assetKey");
  });

  test("comes with what GitHub last said the person asking may do there, and only them", async () => {
    const [user, teammate, workspace] = await Promise.all([
      seedUser(db),
      seedUser(db, "maya"),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, workspace.id, "north-brook/pier");
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Pier",
      branch: null,
      doc: emptyDoc("Pier"),
    });
    const checkedAt = new Date("2026-11-10T12:00:00Z");
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo.id, permission: "write", checkedAt },
    ]);
    const known = async (userId: string | null) =>
      (await getCanvasAccess(db, { canvasId: canvas.id, userId }))!.known;

    expect(await known(user.id)).toEqual({ permission: "write", checkedAt });
    expect(await known(teammate.id)).toBeNull();
    expect(await known(null)).toBeNull();
  });

  test("says whether the person asking is a member of the canvas's workspace", async () => {
    const { canvas, user } = await seedCanvas(db);
    const outsider = await seedUser(db, "outsider");
    const member = async (userId: string | null) =>
      (await getCanvasAccess(db, { canvasId: canvas.id, userId }))!.member;

    expect(await member(outsider.id)).toBe(false);
    expect(await member(null)).toBe(false);
    await upsertMembership(db, {
      workspaceId: canvas.workspaceId,
      userId: user.id,
      role: "member",
    });
    expect(await member(user.id)).toBe(true);
    expect(await member(outsider.id)).toBe(false);
  });

  test("Scratch has no repo, and a canvas that does not exist is null", async () => {
    const { canvas, user } = await seedCanvas(db);

    expect((await getCanvasAccess(db, { canvasId: canvas.id, userId: user.id }))!.repo).toBeNull();
    expect(await getCanvasAccess(db, { canvasId: "cnv_missing", userId: user.id })).toBeNull();
  });
});

describe("getWorkspaceRepo", () => {
  test("finds a repo of the workspace the App can still see, and nothing else", async () => {
    const [workspace, elsewhere] = await Promise.all([seedWorkspace(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, "north-brook/kept");
    const lost = await seedRepo(db, workspace.id, "north-brook/lost");
    await markReposRemoved(db, [lost.githubRepoId]);

    expect(await getWorkspaceRepo(db, { workspaceId: workspace.id, repoId: repo.id })).toEqual(
      repo,
    );
    expect(await getWorkspaceRepo(db, { workspaceId: elsewhere.id, repoId: repo.id })).toBeNull();
    expect(await getWorkspaceRepo(db, { workspaceId: workspace.id, repoId: lost.id })).toBeNull();
  });
});

describe("settleCanvas", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  test("settles and reopens", async () => {
    const { canvas } = await seedCanvas(db);

    expect(await settleCanvas(db, canvas.id, { settled: true, now })).toMatchObject({
      status: "settled",
      settledAt: now,
    });
    // Settling again keeps when it first settled.
    const later = new Date("2026-11-11T12:00:00Z");
    expect(await settleCanvas(db, canvas.id, { settled: true, now: later })).toMatchObject({
      settledAt: now,
    });
    expect(await settleCanvas(db, canvas.id, { settled: false, now })).toMatchObject({
      status: "active",
      settledAt: null,
    });
  });

  test("a canvas that does not exist is null", async () => {
    expect(await settleCanvas(db, "cnv_missing", { settled: true, now })).toBeNull();
  });
});

describe("deleteCanvas", () => {
  test("deletes the canvas with its log and checkpoints, once", async () => {
    const { canvas, user } = await seedCanvas(db);
    await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("op_1", "Gone")],
    });

    expect(await deleteCanvas(db, canvas.id)).toBe(true);
    expect(await deleteCanvas(db, canvas.id)).toBe(false);
    expect(await readDocSource(db, canvas.id)).toBeNull();
  });
});

describe("markCanvasSeen", () => {
  test("only ever moves forward", async () => {
    const { canvas, user } = await seedCanvas(db);
    const read = async () => {
      const [row] = await db.select().from(canvasReads).where(eq(canvasReads.userId, user.id));
      return [row!.seenSeq, row!.seenThreadSeq];
    };
    const key = { userId: user.id, canvasId: canvas.id };

    await db.update(canvases).set({ seq: 9 }).where(eq(canvases.id, canvas.id));
    const items = [];
    for (const text of ["one", "two", "three"]) {
      items.push(
        (await appendThreadItem(db, { canvasId: canvas.id, kind: "message", payload: { text } }))!
          .seq,
      );
    }
    const [first, second, third] = items as [number, number, number];

    await markCanvasSeen(db, { ...key, seq: 5, threadSeq: second });
    expect(await read()).toEqual([5, second]);

    // A slow request from another device, and one that only saw the thread.
    await markCanvasSeen(db, { ...key, seq: 2, threadSeq: first });
    expect(await read()).toEqual([5, second]);
    await markCanvasSeen(db, { ...key, threadSeq: third });
    expect(await read()).toEqual([5, third]);
  });

  test("never past the canvas's seq or its newest thread item, which would hide what comes next", async () => {
    const { canvas, user } = await seedCanvas(db);
    const read = async () => {
      const [row] = await db.select().from(canvasReads).where(eq(canvasReads.userId, user.id));
      return [row!.seenSeq, row!.seenThreadSeq];
    };
    await db.update(canvases).set({ seq: 3 }).where(eq(canvases.id, canvas.id));

    await markCanvasSeen(db, { userId: user.id, canvasId: canvas.id, seq: 9e15, threadSeq: 9e15 });
    expect(await read()).toEqual([3, 0]);

    const item = await appendThreadItem(db, { canvasId: canvas.id, kind: "message", payload: {} });
    await markCanvasSeen(db, { userId: user.id, canvasId: canvas.id, threadSeq: 9e15 });
    expect(await read()).toEqual([3, item!.seq]);
  });
});

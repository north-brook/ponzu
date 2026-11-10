import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq, sql } from "drizzle-orm";
import { actorFor, rename, seedDesign, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { DESIGN_HEAD_COLUMNS, type LiveDesignHead, toDesignHead } from "../head.ts";
import { designReads, designs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { markReposRemoved, upsertMembership } from "./accounts.ts";
import { readDocSource } from "./checkpoints.ts";
import {
  createDesign,
  deleteDesign,
  getDesign,
  getDesignAccess,
  getDesignAssetKey,
  getDesignHead,
  getWorkspaceRepo,
  head as headColumns,
  listWorkspaceDesigns,
  markDesignSeen,
  settleDesign,
} from "./designs.ts";
import { commitOps } from "./ops.ts";
import { recordRepoAccess } from "./repo-access.ts";
import { appendThreadItem } from "./thread.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

describe("createDesign", () => {
  test("makes the design and its first checkpoint together", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id);
    const doc = { ...emptyDoc("Shorter onboarding"), tokens: ":root {\n  --ink: #111;\n}\n" };

    const design = await createDesign(db, {
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

    expect(design.id).toMatch(/^des_[0-9a-z]{16}$/);
    expect(design).toMatchObject({
      status: "active",
      seq: 0,
      agentState: "idle",
      agentArtboards: [],
      needsYouCount: 0,
      prNumber: null,
      prChecks: "none",
      sandboxId: null,
    });
    expect(await getDesign(db, design.id)).toEqual(design);
    expect(await readDocSource(db, design.id)).toEqual({
      seq: 0,
      checkpoint: { seq: 0, doc },
      ops: [],
    });
  });

  test("gives every design its own unguessable asset key", async () => {
    const [one, two] = await Promise.all([seedDesign(db), seedDesign(db)]);
    const [oneKey, twoKey] = await Promise.all([
      getDesignAssetKey(db, one.design.id),
      getDesignAssetKey(db, two.design.id),
    ]);
    expect(oneKey).toMatch(/^[0-9a-z]{32}$/);
    expect(oneKey).not.toBe(twoKey);
    expect(await getDesignAssetKey(db, "des_missing")).toBeNull();
  });

  test("leaves nothing behind when the design cannot be made", async () => {
    const user = await seedUser(db);
    const before = await db.$count(designs);

    const refused = createDesign(db, {
      workspaceId: "ws_missing",
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Orphan",
      branch: null,
      doc: emptyDoc("Orphan"),
    });

    await expect(refused).rejects.toThrow();
    expect(await db.$count(designs)).toBe(before);
  });

  test("refuses a repo that is not the workspace's", async () => {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, elsewhere.id);

    const refused = createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Misfiled",
      branch: "pz/misfiled",
      doc: emptyDoc("Misfiled"),
    });

    await expect(refused).rejects.toThrow("designs_repo_id_workspace_id_fk");
  });

  test("refuses a document Postgres cannot store, before it sends anything", async () => {
    const { user, workspace } = await seedDesign(db);

    const refused = createDesign(db, {
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

describe("getDesign", () => {
  test("is the row without its asset key, which has to be asked for by name", async () => {
    const { design } = await seedDesign(db);

    const row = await getDesign(db, design.id);

    expect(row).toMatchObject({ id: design.id, name: "Lisbon", sandboxId: null });
    expect(row).not.toHaveProperty("assetKey");
    expect(design).not.toHaveProperty("assetKey");
  });
});

describe("getDesignHead", () => {
  test("is the small part of the row that clients watch", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });

    const head = await getDesignHead(db, design.id);

    expect(head).toMatchObject({ id: design.id, workspaceId: design.workspaceId, seq: 1 });
    // Whatever joins this list is re-sent to every watcher on every op. Nothing secret, nothing large.
    expect(Object.keys(head!).sort()).toEqual([
      "agentArtboards",
      "agentState",
      "agentStatus",
      "icon",
      "id",
      "lastActivityAt",
      "name",
      "needsYouCount",
      "prAutoMerge",
      "prChecks",
      "prMergeable",
      "prNumber",
      "prState",
      "previewSeq",
      "seq",
      "status",
      "workspaceId",
    ]);
  });

  test("is null for a design that does not exist", async () => {
    expect(await getDesignHead(db, "des_missing")).toBeNull();
    expect(await getDesign(db, "des_missing")).toBeNull();
  });

  test("a live query's columns are the head's, by their own names", () => {
    expect<string[]>([...DESIGN_HEAD_COLUMNS]).toEqual(
      Object.values(headColumns).map((column) => column.name),
    );
  });

  test("a row as Realtime delivers it decodes to the same head", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: Array.from({ length: 10 }, (_, i) => rename(`op-${i}`, `v${i}`)),
    });
    await db.update(designs).set({ previewSeq: 9 }).where(eq(designs.id, design.id));
    // What the Realtime SDK hands over: keys are column names, a bigint is a string.
    const { rows } = await db.execute<LiveDesignHead>(sql`
      select ${sql.raw(DESIGN_HEAD_COLUMNS.join(", "))} from designs where id = ${design.id}
    `);
    const live = { ...rows[0]!, seq: "10", preview_seq: "9" };

    const decoded = toDesignHead(live);

    expect(decoded).toEqual((await getDesignHead(db, design.id))!);
    expect(decoded.seq).toBe(10);
    expect(decoded.previewSeq).toBe(9);
    expect(toDesignHead({ ...live, preview_seq: null }).previewSeq).toBeNull();
  });
});

describe("listWorkspaceDesigns", () => {
  async function workspaceWithDesigns() {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, workspace.id);
    const make = (workspaceId: string, name: string, repoId: string | null) =>
      createDesign(db, {
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
        .update(designs)
        .set({ lastActivityAt: new Date(time) })
        .where(eq(designs.id, id));
    await at(oldest.id, "2026-11-01T00:00:00Z");
    await at(settled.id, "2026-11-02T00:00:00Z");
    await at(newest.id, "2026-11-03T00:00:00Z");
    await db
      .update(designs)
      .set({ status: "settled", settledAt: new Date() })
      .where(eq(designs.id, settled.id));
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo.id, permission: "read", checkedAt: new Date() },
    ]);
    return { user, workspace, repo, oldest, settled, newest };
  }

  test("lists one workspace's designs, most recently active first", async () => {
    const { user, workspace } = await workspaceWithDesigns();

    const all = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    expect(all.map((design) => design.name)).toEqual(["Newest", "Settled", "Oldest"]);
    expect(all.map((design) => design.repoFullName)).toEqual([null, null, "north-brook/fernwood"]);
  });

  test("lists what a sidebar row shows, and no asset key or sandbox", async () => {
    const { user, workspace, oldest } = await workspaceWithDesigns();

    const all = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    const row = all.find((design) => design.id === oldest.id)!;
    expect(row).toMatchObject({
      ...(await getDesignHead(db, oldest.id))!,
      repoId: oldest.repoId,
      ownerId: user.id,
      branch: "pz/oldest",
      settledAt: null,
    });
    // One `c.json(designs)` must not hand every design's files to everyone in the workspace.
    for (const design of all) {
      expect(design).not.toHaveProperty("assetKey");
      expect(design).not.toHaveProperty("sandboxId");
    }
  });

  test("filters by status", async () => {
    const { user, workspace } = await workspaceWithDesigns();
    const list = (status: "active" | "settled") =>
      listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id, status });

    expect((await list("active")).map((design) => design.name)).toEqual(["Newest", "Oldest"]);
    expect((await list("settled")).map((design) => design.name)).toEqual(["Settled"]);
  });

  test("says how far the viewer has looked, and only the viewer", async () => {
    const { user, workspace, newest, oldest } = await workspaceWithDesigns();
    const teammate = await seedUser(db, "maya");
    await db.update(designs).set({ seq: 4 }).where(eq(designs.id, newest.id));
    const item = await appendThreadItem(db, {
      designId: newest.id,
      kind: "message",
      payload: { text: "Hi" },
    });
    await markDesignSeen(db, {
      userId: user.id,
      designId: newest.id,
      seq: 4,
      threadSeq: item!.seq,
    });
    await markDesignSeen(db, { userId: teammate.id, designId: oldest.id, seq: 2 });

    const mine = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    expect(mine.map((d) => [d.name, d.seenSeq, d.seenThreadSeq])).toEqual([
      ["Newest", 4, item!.seq],
      ["Settled", null, null],
      ["Oldest", null, null],
    ]);
  });

  test("lists a repo's designs to whoever repo_access says can read it, and Scratch to its owner only", async () => {
    const { workspace, repo } = await workspaceWithDesigns();
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
    const names = async (userId: string) =>
      (await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId })).map((d) => d.name);

    expect(await names(reader.id)).toEqual(["Oldest"]);
    expect(await names(writer.id)).toEqual(["Oldest"]);
    expect(await names(revoked.id)).toEqual([]);
    expect(await names(unasked.id)).toEqual([]);
  });
});

describe("getDesignAccess", () => {
  test("a design in a repo comes with the repo's GitHub id and name, and the installation", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, "north-brook/harbor");
    const design = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Harbor",
      branch: "pz/harbor",
      doc: emptyDoc("Harbor"),
    });

    const access = await getDesignAccess(db, { designId: design.id, userId: user.id });

    expect(access).toEqual({
      design: (await getDesign(db, design.id))!,
      repo: { id: repo.id, githubRepoId: repo.githubRepoId, fullName: "north-brook/harbor" },
      installationId: workspace.installationId,
      known: null,
      member: false,
    });
    expect(access!.design).not.toHaveProperty("assetKey");
  });

  test("comes with what GitHub last said the person asking may do there, and only them", async () => {
    const [user, teammate, workspace] = await Promise.all([
      seedUser(db),
      seedUser(db, "maya"),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, workspace.id, "north-brook/pier");
    const design = await createDesign(db, {
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
      (await getDesignAccess(db, { designId: design.id, userId }))!.known;

    expect(await known(user.id)).toEqual({ permission: "write", checkedAt });
    expect(await known(teammate.id)).toBeNull();
    expect(await known(null)).toBeNull();
  });

  test("says whether the person asking is a member of the design's workspace", async () => {
    const { design, user } = await seedDesign(db);
    const outsider = await seedUser(db, "outsider");
    const member = async (userId: string | null) =>
      (await getDesignAccess(db, { designId: design.id, userId }))!.member;

    expect(await member(outsider.id)).toBe(false);
    expect(await member(null)).toBe(false);
    await upsertMembership(db, {
      workspaceId: design.workspaceId,
      userId: user.id,
      role: "member",
    });
    expect(await member(user.id)).toBe(true);
    expect(await member(outsider.id)).toBe(false);
  });

  test("Scratch has no repo, and a design that does not exist is null", async () => {
    const { design, user } = await seedDesign(db);

    expect((await getDesignAccess(db, { designId: design.id, userId: user.id }))!.repo).toBeNull();
    expect(await getDesignAccess(db, { designId: "des_missing", userId: user.id })).toBeNull();
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

describe("settleDesign", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  test("settles and reopens", async () => {
    const { design } = await seedDesign(db);

    expect(await settleDesign(db, design.id, { settled: true, now })).toMatchObject({
      status: "settled",
      settledAt: now,
    });
    // Settling again keeps when it first settled.
    const later = new Date("2026-11-11T12:00:00Z");
    expect(await settleDesign(db, design.id, { settled: true, now: later })).toMatchObject({
      settledAt: now,
    });
    expect(await settleDesign(db, design.id, { settled: false, now })).toMatchObject({
      status: "active",
      settledAt: null,
    });
  });

  test("a design that does not exist is null", async () => {
    expect(await settleDesign(db, "des_missing", { settled: true, now })).toBeNull();
  });
});

describe("deleteDesign", () => {
  test("deletes the design with its log and checkpoints, once", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("op_1", "Gone")],
    });

    expect(await deleteDesign(db, design.id)).toBe(true);
    expect(await deleteDesign(db, design.id)).toBe(false);
    expect(await readDocSource(db, design.id)).toBeNull();
  });
});

describe("markDesignSeen", () => {
  test("only ever moves forward", async () => {
    const { design, user } = await seedDesign(db);
    const read = async () => {
      const [row] = await db.select().from(designReads).where(eq(designReads.userId, user.id));
      return [row!.seenSeq, row!.seenThreadSeq];
    };
    const key = { userId: user.id, designId: design.id };

    await db.update(designs).set({ seq: 9 }).where(eq(designs.id, design.id));
    const items = [];
    for (const text of ["one", "two", "three"]) {
      items.push(
        (await appendThreadItem(db, { designId: design.id, kind: "message", payload: { text } }))!
          .seq,
      );
    }
    const [first, second, third] = items as [number, number, number];

    await markDesignSeen(db, { ...key, seq: 5, threadSeq: second });
    expect(await read()).toEqual([5, second]);

    // A slow request from another device, and one that only saw the thread.
    await markDesignSeen(db, { ...key, seq: 2, threadSeq: first });
    expect(await read()).toEqual([5, second]);
    await markDesignSeen(db, { ...key, threadSeq: third });
    expect(await read()).toEqual([5, third]);
  });

  test("never past the design's seq or its newest thread item, which would hide what comes next", async () => {
    const { design, user } = await seedDesign(db);
    const read = async () => {
      const [row] = await db.select().from(designReads).where(eq(designReads.userId, user.id));
      return [row!.seenSeq, row!.seenThreadSeq];
    };
    await db.update(designs).set({ seq: 3 }).where(eq(designs.id, design.id));

    await markDesignSeen(db, { userId: user.id, designId: design.id, seq: 9e15, threadSeq: 9e15 });
    expect(await read()).toEqual([3, 0]);

    const item = await appendThreadItem(db, { designId: design.id, kind: "message", payload: {} });
    await markDesignSeen(db, { userId: user.id, designId: design.id, threadSeq: 9e15 });
    expect(await read()).toEqual([3, item!.seq]);
  });
});

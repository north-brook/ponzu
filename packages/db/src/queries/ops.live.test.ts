// PGlite is one connection, so the races in ops.test.ts take turns: they prove the commit's
// logic, not its locking. This file races real transactions against each other. It runs only
// when PONZU_TEST_DATABASE_URL names a migrated Postgres (the Neon `dev` branch), and it
// deletes what it creates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { createDb } from "../client.ts";
import { rename } from "../fixtures.ts";
import { designs, users, workspaces } from "../schema/index.ts";
import { upsertUser, upsertWorkspace } from "./accounts.ts";
import { createDesign, getDesign } from "./designs.ts";
import { type Actor, commitOps, readOps } from "./ops.ts";

const url = process.env.PONZU_TEST_DATABASE_URL;

describe.skipIf(!url)("commitOps on a real Postgres, over HTTP", () => {
  // Each call is its own HTTP request and so its own transaction.
  const db = createDb(url ?? "postgres://unused");
  // No GitHub id is negative, so these rows cannot be anyone's.
  const githubId = -Date.now();
  let actor: Actor;
  let designId: string;

  beforeAll(async () => {
    const user = await upsertUser(db, {
      workosUserId: `test_${githubId}`,
      githubUserId: githubId,
      githubLogin: "ponzu-test",
      name: "Test",
      email: null,
      avatarUrl: null,
    });
    const workspace = await upsertWorkspace(db, {
      githubAccountId: githubId,
      githubLogin: "ponzu-test",
      kind: "personal",
      name: "Test",
      avatarUrl: null,
      installationId: githubId,
      repositorySelection: "all",
      installedByUserId: user.id,
    });
    const design = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Race",
      branch: null,
      doc: emptyDoc("Race"),
    });
    actor = { kind: "user", id: user.id, name: "Test" };
    designId = design.id;
  });

  afterAll(async () => {
    await db.delete(designs).where(eq(designs.id, designId));
    await db.delete(workspaces).where(eq(workspaces.githubAccountId, githubId));
    await db.delete(users).where(eq(users.githubUserId, githubId));
  });

  test("of committers racing on one seq exactly one wins, and the log has no gaps", async () => {
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, racer) =>
          commitOps(db, {
            designId,
            expectedSeq: round * 2,
            actor,
            ops: [rename(`${round}-${racer}-1`, "A"), rename(`${round}-${racer}-2`, "B")],
          }),
        ),
      );
      expect(results.filter((result) => result.kind === "committed")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "conflict")).toHaveLength(5);
    }

    expect((await getDesign(db, designId))!.seq).toBe(rounds * 2);
    const log = await readOps(db, { designId, after: 0 });
    if (log?.kind !== "ok") throw new Error("expected ops");
    expect(log.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: rounds * 2 }, (_, i) => i + 1),
    );
  }, 60_000);

  test("one op posted many times at once is stored once and never fails", async () => {
    const seq = (await getDesign(db, designId))!.seq;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        commitOps(db, { designId, expectedSeq: seq, actor, ops: [rename("same", "Same")] }),
      ),
    );

    // Whoever lost the row waited, saw the seq had moved and got a conflict; a retry replays.
    expect(results.filter((result) => result.kind === "committed").length).toBeGreaterThan(0);
    expect((await getDesign(db, designId))!.seq).toBe(seq + 1);
    const retry = await commitOps(db, {
      designId,
      expectedSeq: seq,
      actor,
      ops: [rename("same", "x")],
    });
    expect(retry).toMatchObject({ kind: "committed", seq: seq + 1, replayed: ["same"] });
  }, 60_000);
});

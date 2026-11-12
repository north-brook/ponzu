import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { deleteUser } from "./account-deletion.ts";
import { upsertMembership } from "./accounts.ts";

/*
 * The forget job goes in with the row's deletion: if the two were separate statements, a
 * failure between them would leave a deleted person whose WorkOS id nothing remembers.
 */

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const job = { kind: "account.forget", maxAttempts: 10, runAt: new Date(), lockedBy: "w1" };

async function forgetJobs(userId: string) {
  const { rows } = (await db.execute(
    `select kind, key, payload, locked_by, attempts from jobs where kind = 'account.forget' and key = '${userId}'`,
  )) as unknown as { rows: Record<string, unknown>[] };
  return rows;
}

describe("deleteUser", () => {
  test("records the forget job, with the WorkOS id, in the same statement", async () => {
    const user = await seedUser(db, "leaving");
    const deleted = await deleteUser(db, user.id, job);

    expect(deleted).toMatchObject({ status: "deleted", workosUserId: user.workosUserId });
    expect(deleted.status === "deleted" && deleted.job).toMatchObject({
      kind: "account.forget",
      payload: { userId: user.id, workosUserId: user.workosUserId },
      attempts: 1,
      maxAttempts: 10,
    });
    expect(await forgetJobs(user.id)).toEqual([
      {
        kind: "account.forget",
        key: user.id,
        payload: { userId: user.id, workosUserId: user.workosUserId },
        locked_by: "w1",
        attempts: 1,
      },
    ]);
    // Asked again: nothing is deleted, and nothing more is recorded.
    expect(await deleteUser(db, user.id, job)).toEqual({ status: "gone" });
    expect(await forgetJobs(user.id)).toHaveLength(1);
  });

  test("records nothing when the deletion is refused", async () => {
    const admin = await seedUser(db, "only-admin");
    const other = await seedUser(db, "stays");
    const workspace = await seedWorkspace(db, "team");
    await upsertMembership(db, { workspaceId: workspace.id, userId: admin.id, role: "admin" });
    await upsertMembership(db, { workspaceId: workspace.id, userId: other.id, role: "member" });

    expect(await deleteUser(db, admin.id, job)).toEqual({ status: "sole_admin" });
    expect(await forgetJobs(admin.id)).toEqual([]);
  });
});

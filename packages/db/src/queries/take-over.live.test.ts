// Taking over a canvas on a real Postgres, where statements truly run at once: teammates
// pressing Take over together, and a take-over racing its owner's return. Runs only when
// PONZU_TEST_DATABASE_URL names a migrated database (see ../live.ts); CI gives it a Postgres 18.
import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { newId, randomString } from "../ids.ts";
import { describeLive } from "../live.ts";
import { threadItems } from "../schema/index.ts";
import { upsertMembership } from "./accounts.ts";
import { getCanvas } from "./canvases.ts";
import { connectClaudeAccount } from "./claude.ts";
import { takeOverCanvas } from "./take-over.ts";

const times = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describeLive("taking over a canvas on a real Postgres", ({ db, close }) => {
  afterAll(close);

  /** A member of the workspace with Claude connected. */
  async function teammate(workspaceId: string, login: string) {
    const user = await seedUser(db, login);
    await upsertMembership(db, { workspaceId, userId: user.id, role: "member" });
    await connectClaudeAccount(db, {
      id: newId("cla"),
      userId: user.id,
      kind: "api_key",
      encryptedCredential: "sealed",
      keyHint: null,
      expiresAt: null,
      now: new Date(),
    });
    return user;
  }

  const notices = async (canvasId: string) =>
    db
      .select()
      .from(threadItems)
      .where(
        and(
          eq(threadItems.canvasId, canvasId),
          sql`${threadItems.payload}->>'type' = 'owner_changed'`,
        ),
      );

  const takeOver = (canvasId: string, userId: string) =>
    takeOverCanvas(db, {
      canvasId,
      userId,
      noticeId: `ti_owner-${randomString(16)}`,
      notice: { type: "owner_changed", by: { id: userId, name: "Teammate", login: null } },
      now: new Date(),
    });

  test("teammates taking over at once: exactly one owns it, and the thread says so once", async () => {
    for (let round = 0; round < 5; round++) {
      // The owner seeded here was never a member of the workspace: as if they had left.
      const { canvas, workspace } = await seedCanvas(db);
      const people = await Promise.all(times(6, (i) => teammate(workspace.id, `t${round}-${i}`)));

      const results = await Promise.all(people.map((person) => takeOver(canvas.id, person.id)));

      const taken = results.flatMap((result, i) =>
        result?.outcome === "taken" ? [people[i]!] : [],
      );
      expect(taken).toHaveLength(1);
      expect(results.filter((result) => result?.outcome === "not_ownerless")).toHaveLength(5);
      expect((await getCanvas(db, canvas.id))!.ownerId).toBe(taken[0]!.id);
      expect(await notices(canvas.id)).toHaveLength(1);
    }
  }, 60_000);

  test("a take-over racing the owner's return either happens whole or not at all", async () => {
    for (let round = 0; round < 10; round++) {
      const { canvas, workspace, user: owner } = await seedCanvas(db);
      const maya = await teammate(workspace.id, `m${round}`);

      const [result] = await Promise.all([
        takeOver(canvas.id, maya.id),
        upsertMembership(db, { workspaceId: workspace.id, userId: owner.id, role: "member" }),
      ]);

      const row = (await getCanvas(db, canvas.id))!;
      const said = await notices(canvas.id);
      if (result?.outcome === "taken") {
        expect(row.ownerId).toBe(maya.id);
        expect(said).toHaveLength(1);
      } else {
        expect(result?.outcome).toBe("not_ownerless");
        expect(row.ownerId).toBe(owner.id);
        expect(said).toHaveLength(0);
      }
    }
  }, 60_000);
});

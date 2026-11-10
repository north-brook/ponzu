import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedDesign } from "../fixtures.ts";
import { runnerTokens } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createRunnerToken, revokeRunnerTokens, verifyRunnerToken } from "./runner-tokens.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("a token verifies as its design, and only as its design", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);

  const issued = await createRunnerToken(db, { designId: one.design.id, ttlSeconds: 3600 });
  const theirs = await createRunnerToken(db, { designId: other.design.id, ttlSeconds: 3600 });

  expect(issued.token).toMatch(/^pzr_[0-9a-z]{52}$/);
  expect(issued.token).not.toBe(theirs.token);
  const lifetime = issued.expiresAt.getTime() - Date.now();
  expect(lifetime).toBeGreaterThan(3500_000);
  expect(lifetime).toBeLessThan(3700_000);
  expect(await verifyRunnerToken(db, issued.token)).toEqual({
    id: issued.id,
    designId: one.design.id,
  });
  expect(await verifyRunnerToken(db, theirs.token)).toMatchObject({ designId: other.design.id });
});

test("the table holds a hash, never the token", async () => {
  const { design } = await seedDesign(db);
  const { id, token } = await createRunnerToken(db, { designId: design.id, ttlSeconds: 60 });

  const [row] = await db.select().from(runnerTokens).where(eq(runnerTokens.id, id));

  expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(row)).not.toContain(token.slice(4));
  // Presenting the hash itself gets nowhere.
  expect(await verifyRunnerToken(db, row!.tokenHash)).toBeNull();
});

test("an unknown token is nobody", async () => {
  expect(await verifyRunnerToken(db, "pzr_made_up")).toBeNull();
  expect(await verifyRunnerToken(db, "")).toBeNull();
});

test("an expired token stops working", async () => {
  const { design } = await seedDesign(db);
  const { id, token } = await createRunnerToken(db, { designId: design.id, ttlSeconds: 60 });

  await db
    .update(runnerTokens)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(runnerTokens.id, id));

  expect(await verifyRunnerToken(db, token)).toBeNull();
});

test("revoking ends every token a design has, and no other design's", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const first = await createRunnerToken(db, { designId: one.design.id, ttlSeconds: 60 });
  const second = await createRunnerToken(db, { designId: one.design.id, ttlSeconds: 60 });
  const theirs = await createRunnerToken(db, { designId: other.design.id, ttlSeconds: 60 });

  expect(await revokeRunnerTokens(db, one.design.id)).toBe(2);

  expect(await verifyRunnerToken(db, first.token)).toBeNull();
  expect(await verifyRunnerToken(db, second.token)).toBeNull();
  expect(await verifyRunnerToken(db, theirs.token)).not.toBeNull();
  expect(await revokeRunnerTokens(db, one.design.id)).toBe(0);
  // A token made after the revocation works.
  const fresh = await createRunnerToken(db, { designId: one.design.id, ttlSeconds: 60 });
  expect(await verifyRunnerToken(db, fresh.token)).not.toBeNull();
});

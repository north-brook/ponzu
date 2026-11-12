import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrationsFolder } from "../migrations.ts";
import { createTestDb } from "../testing.ts";
import { countAppliedMigrations, EXPECTED_MIGRATIONS } from "./migrations.ts";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));

test("expected is the journal's entry count, the number migrate.ts compares", () => {
  expect(EXPECTED_MIGRATIONS).toBe(journal.entries.length);
});

test("applied counts drizzle's record, and follows it when a row goes", async () => {
  const db = await createTestDb();
  try {
    expect(await countAppliedMigrations(db)).toBe(EXPECTED_MIGRATIONS);
    await db.execute(
      sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`,
    );
    expect(await countAppliedMigrations(db)).toBe(EXPECTED_MIGRATIONS - 1);
  } finally {
    await db.$client.close();
  }
});

test("a database that was never migrated fails the count rather than answering zero", async () => {
  const db = await createTestDb();
  try {
    await db.execute(sql`drop schema drizzle cascade`);
    await expect(countAppliedMigrations(db)).rejects.toThrow();
  } finally {
    await db.$client.close();
  }
});

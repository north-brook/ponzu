import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { seedUser } from "./fixtures.ts";
import { migrationsFolder } from "./migrations.ts";
import { users } from "./schema/index.ts";
import { createEmptyTestDb, createTestDb, testDbsPrepared } from "./testing.ts";

test("a test database has every migration applied, however it was made", async () => {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const db = await createTestDb();
  try {
    const applied = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.count).toBe(journal.entries.length);
  } finally {
    await db.$client.close();
  }
});

test("two test databases share nothing: what one writes the other never sees", async () => {
  const one = await createTestDb();
  try {
    await seedUser(one);
    expect(await one.$count(users)).toBe(1);
    // Made after the write, from the same saved copy: the copy took none of it.
    const two = await createTestDb();
    expect(await two.$count(users)).toBe(0);
    await two.$client.close();
  } finally {
    await one.$client.close();
  }
});

test("an empty test database has nothing in it, and can make the extensions the migrations do", async () => {
  const client = await createEmptyTestDb();
  try {
    const tables = await client.query(
      "select relname from pg_class where relnamespace = 'public'::regnamespace",
    );
    expect(tables.rows).toEqual([]);
    await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } finally {
    await client.close();
  }
});

// initdb under load has outlasted bun's five seconds for a hook, so it runs once, in the preload
// (test-preload.ts), and a test loads a copy instead of making its own Postgres.
const ROOT = join(import.meta.dir, "../../..");

// Read as this file loads, before any test in it runs: the preload has already made both copies
// and loaded the migrated one, so no test here or in any other file makes one.
const preparedBeforeTests = testDbsPrepared();

test("bun test makes the test databases before any test file loads", () => {
  expect(preparedBeforeTests).toBe(true);
});

test("no test makes its own Postgres: each loads a copy from @ponzu/db/testing", () => {
  const offenders: string[] = [];
  for (const path of new Bun.Glob("{apps,packages,scripts}/**/*.ts").scanSync(ROOT)) {
    if (path.includes("node_modules") || path === "packages/db/src/testing.ts") continue;
    if (!/\.test\.ts$|\/testing\//.test(path)) continue;
    if (/new PGlite\(|PGlite\.create\(/.test(readFileSync(join(ROOT, path), "utf8")))
      offenders.push(path);
  }
  expect(offenders).toEqual([]);
});

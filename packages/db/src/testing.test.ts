import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { seedUser } from "./fixtures.ts";
import { migrationsFolder } from "./migrations.ts";
import { users } from "./schema/index.ts";
import { createTestDb } from "./testing.ts";

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

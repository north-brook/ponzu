import { sql } from "drizzle-orm";
import journal from "../../migrations/meta/_journal.json" with { type: "json" };
import type { Db } from "../client.ts";
import { run } from "./run.ts";

/**
 * How many migrations this checkout's journal lists. Imported, not read from disk, so a bundle
 * (the API's `dist/index.js`) carries the number it was built with and needs no file beside it.
 */
export const EXPECTED_MIGRATIONS: number = journal.entries.length;

/**
 * How many migrations the database has applied: the rows in drizzle's own record, which is
 * what `migrate.ts` compares with the journal. A database that was never migrated has no such
 * table, and the statement fails.
 */
export async function countAppliedMigrations(db: Db): Promise<number> {
  const result = (await run(
    db.execute(sql`select count(*)::int as applied from drizzle.__drizzle_migrations`),
  )) as unknown as { rows: { applied: number | string }[] };
  return Number(result.rows[0]?.applied ?? 0);
}

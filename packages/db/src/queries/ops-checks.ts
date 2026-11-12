import { sql } from "drizzle-orm";
import journal from "../../migrations/meta/_journal.json" with { type: "json" };
import type { Db } from "../client.ts";
import { queryJson } from "./json.ts";

/*
 * What the API's own checks read of the database (`/v1/health`, `/v1/cron/selfcheck`):
 * counts only, never a value.
 */

/**
 * How many migrations this checkout has, from drizzle's journal. Imported as JSON, so a bundle
 * carries the number it was built with: what `migrate.ts` compares the database with.
 */
export const EXPECTED_MIGRATIONS: number = journal.entries.length;

/** How many migrations the database has applied, as `migrate.ts` counts them. */
export async function countAppliedMigrations(db: Db): Promise<number> {
  const counted = await queryJson<{ applied: number }>(
    db,
    sql`select json_build_object('applied', count(*)::int) as result from drizzle.__drizzle_migrations`,
  );
  return counted?.applied ?? 0;
}

/**
 * Every column that holds a value sealed by the API's vault (`apps/api/src/vault/vault.ts`),
 * as `table.column`. A sealed column added to the schema is added here, or the selfcheck's
 * count of values under old keys misses it.
 */
export const SEALED_COLUMNS = [
  "github_user_tokens.encrypted_access_token",
  "github_user_tokens.encrypted_refresh_token",
  "repo_secrets.encrypted_value",
  "claude_accounts.encrypted_credential",
  "sandboxes.encrypted_port_token",
] as const;

/**
 * How many sealed values, in each of `SEALED_COLUMNS`, were sealed with a key other than
 * `keyId`: what is left to reseal after a rotation. A sealed value is `pzv1.<key id>.…`, so
 * this reads only that part of each.
 */
export async function countSealedUnderOtherKeys(
  db: Db,
  keyId: string,
): Promise<Record<(typeof SEALED_COLUMNS)[number], number>> {
  const counts = SEALED_COLUMNS.map((name) => {
    const [table, column] = name.split(".") as [string, string];
    return sql`${name}::text, (select count(*)::int from ${sql.identifier(table)}
      where ${sql.identifier(column)} is not null
        and split_part(${sql.identifier(column)}, '.', 2) <> ${keyId})`;
  });
  const counted = await queryJson<Record<(typeof SEALED_COLUMNS)[number], number>>(
    db,
    sql`select json_build_object(${sql.join(counts, sql`, `)}) as result`,
  );
  return counted!;
}

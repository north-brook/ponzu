import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { createEmptyTestDb, createTestDb } from "../testing.ts";
import * as schema from "./index.ts";

// Everything Postgres names in the public schema, and what each is: relations, constraints of
// every kind (NOT NULL included), every column of a table or an index, index definitions,
// defaults and types. The drift test compares the snapshot with the schema; this compares the
// database the migrations build with the one the schema describes, which catches a hand-written
// migration that names something differently from what Drizzle would have (a constraint, an
// index's own column, a Postgres 18 NOT NULL).
const CATALOG = `
  select 'rel ' || relkind::text || ' ' || relname as line from pg_class
   where relnamespace = 'public'::regnamespace
  union all
  select 'con ' || contype::text || ' ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'att ' || c.relkind::text || ' ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'idx ' || pg_get_indexdef(indexrelid) from pg_index
   where indrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
  union all
  select 'def ' || adrelid::regclass::text || ' ' || pg_get_expr(adbin, adrelid) from pg_attrdef
   where adrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
  union all
  select 'typ ' || typname from pg_type where typnamespace = 'public'::regnamespace
  order by 1`;

let migrated: Awaited<ReturnType<typeof createTestDb>>;
let fresh: PGlite;
beforeAll(async () => {
  migrated = await createTestDb();
  fresh = await createEmptyTestDb();
  // drizzle-kit does not emit extensions; the migration that needs one creates it by hand.
  await fresh.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(empty, generateDrizzleJson(schema, empty.id))) {
    await fresh.exec(statement);
  }
});
afterAll(async () => {
  await migrated.$client.close();
  await fresh.close();
});

const catalog = async (client: PGlite) =>
  (await client.query<{ line: string }>(CATALOG)).rows.map((row) => row.line);

test("the migrations build the database the schema describes, name for name", async () => {
  expect(await catalog(migrated.$client)).toEqual(await catalog(fresh));
});

test("no name in the database says design", async () => {
  expect((await catalog(migrated.$client)).filter((line) => /design/i.test(line))).toEqual([]);
});

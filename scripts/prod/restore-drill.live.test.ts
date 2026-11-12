// The drill's counter against a real Postgres. Runs only when PONZU_TEST_DATABASE_URL names a
// database with "test" in its name; it creates and drops its own schema and touches nothing else.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { countRows } from "./restore-drill.ts";

const url = process.env.PONZU_TEST_DATABASE_URL;
const usable = !!url && /test/.test(new URL(url).pathname);
const SCHEMA = "drill_count_test";

beforeAll(async () => {
  if (!usable) return;
  const { SQL } = await import("bun");
  const db = new SQL(url as string);
  await db.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await db.unsafe(`create schema ${SCHEMA}`);
  await db.unsafe(`create table ${SCHEMA}."we""ird name" (x int)`);
  await db.unsafe(`insert into ${SCHEMA}."we""ird name" select generate_series(1, 5)`);
  await db.unsafe(`create table ${SCHEMA}.empty (x int)`);
  await db.unsafe(`create view ${SCHEMA}.not_a_table as select 1 as x`);
  await db.close();
});

afterAll(async () => {
  if (!usable) return;
  const { SQL } = await import("bun");
  const db = new SQL(url as string);
  await db.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await db.close();
});

test.skipIf(!usable)("counts every base table, quoting odd names, and no view", async () => {
  const counts = await countRows(url as string);
  expect(counts[`${SCHEMA}.we"ird name`]).toBe(5);
  expect(counts[`${SCHEMA}.empty`]).toBe(0);
  expect(`${SCHEMA}.not_a_table` in counts).toBe(false);
  expect(Object.keys(counts).some((t) => t.startsWith("pg_catalog."))).toBe(false);
});

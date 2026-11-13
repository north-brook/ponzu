import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  GRANDFATHERED,
  GRANDFATHERED_SHA256,
  lintMigration,
  lintMigrations,
  statements,
} from "./migrations.ts";

const DIR = join(import.meta.dir, "../../packages/db/migrations");
const BREAK = "--> statement-breakpoint";

describe("the migration lint", () => {
  test("DROP COLUMN without a contract line fails, naming the line", () => {
    const sql = [
      `CREATE TABLE "a" ("id" text PRIMARY KEY);${BREAK}`,
      `ALTER TABLE "b" DROP COLUMN "old";${BREAK}`,
      `CREATE INDEX "i" ON "a" ("id");`,
    ].join("\n");
    expect(lintMigration("0030_x.sql", sql)).toEqual([
      {
        file: "0030_x.sql",
        line: 2,
        rule: "DROP COLUMN",
        statement: `ALTER TABLE "b" DROP COLUMN "old";${BREAK}`,
      },
    ]);
  });

  test("the same with a contract line on the line before passes", () => {
    const sql = [
      `CREATE TABLE "a" ("id" text PRIMARY KEY);${BREAK}`,
      "-- contract: 2.3.0 stopped reading b.old, and every deployment since is newer",
      `ALTER TABLE "b" DROP COLUMN "old";${BREAK}`,
    ].join("\n");
    expect(lintMigration("0030_x.sql", sql)).toEqual([]);
  });

  test("a contract line two lines up, or one with no reason, does not count", () => {
    const far = ["-- contract: too far", "", `ALTER TABLE "b" DROP COLUMN "old";`].join("\n");
    expect(lintMigration("f.sql", far).map((f) => f.line)).toEqual([3]);
    const empty = ["-- contract:", `ALTER TABLE "b" DROP COLUMN "old";`].join("\n");
    expect(lintMigration("f.sql", empty).map((f) => f.line)).toEqual([2]);
    const covers = [
      "-- contract: only the first",
      `ALTER TABLE "b" DROP COLUMN "x";${BREAK}`,
      `ALTER TABLE "b" DROP COLUMN "y";`,
    ].join("\n");
    expect(lintMigration("f.sql", covers).map((f) => f.line)).toEqual([3]);
  });

  test("each destructive statement, exactly", () => {
    const rule = (sql: string) => lintMigration("f.sql", sql).map((f) => f.rule);
    expect(rule(`DROP TABLE "member_repos" CASCADE;`)).toEqual(["DROP TABLE"]);
    expect(rule(`drop table if exists "x";`)).toEqual(["DROP TABLE"]);
    expect(rule(`ALTER TABLE "a" DROP COLUMN "b";`)).toEqual(["DROP COLUMN"]);
    expect(rule(`ALTER TABLE "a" RENAME TO "b";`)).toEqual(["RENAME"]);
    expect(rule(`ALTER TABLE "a" RENAME COLUMN "b" TO "c";`)).toEqual(["RENAME"]);
    expect(rule(`ALTER INDEX "a" RENAME TO "b";`)).toEqual(["RENAME"]);
    expect(rule(`ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE bigint;`)).toEqual([
      "ALTER COLUMN … TYPE",
    ]);
    expect(rule(`ALTER TABLE "a" ALTER COLUMN b TYPE bigint USING b::bigint;`)).toEqual([
      "ALTER COLUMN … TYPE",
    ]);
    expect(rule(`ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;`)).toEqual(["SET NOT NULL"]);
    expect(rule(`ALTER TABLE "a" ADD COLUMN "b" integer NOT NULL;`)).toEqual([
      "ADD COLUMN … NOT NULL without a DEFAULT",
    ]);
    expect(
      rule(
        `ALTER TABLE "a" ADD COLUMN "b" integer DEFAULT 0 NOT NULL, ADD COLUMN "c" text NOT NULL;`,
      ),
    ).toEqual(["ADD COLUMN … NOT NULL without a DEFAULT"]);
    expect(rule(`ALTER TABLE "a" ALTER COLUMN "b" DROP DEFAULT;`)).toEqual(["DROP DEFAULT"]);
    expect(rule(`ALTER TABLE a ALTER b DROP DEFAULT;`)).toEqual(["DROP DEFAULT"]);
    const dropped = "DROP INDEX, TYPE, DOMAIN, EXTENSION, FUNCTION or SEQUENCE";
    expect(rule(`DROP INDEX "users_email_unique";`)).toEqual([dropped]);
    expect(rule(`DROP TYPE "public"."plan" CASCADE;`)).toEqual([dropped]);
    expect(rule(`DROP EXTENSION IF EXISTS pg_trgm;`)).toEqual([dropped]);
    expect(rule(`DROP FUNCTION fold(text);`)).toEqual([dropped]);
    expect(rule(`DROP SEQUENCE "s";`)).toEqual([dropped]);
    expect(rule(`DROP DOMAIN "d";`)).toEqual([dropped]);
  });

  test("what only adds passes", () => {
    const sql = [
      `CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL, "n" integer NOT NULL);${BREAK}`,
      `ALTER TABLE "a" ADD COLUMN "b" integer DEFAULT 0 NOT NULL;${BREAK}`,
      `ALTER TABLE "a" ADD COLUMN IF NOT EXISTS "c" text;${BREAK}`,
      `ALTER TABLE "a" ADD COLUMN "s" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "n")) STORED NOT NULL;${BREAK}`,
      `ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL;${BREAK}`,
      `ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT 1;${BREAK}`,
      `ALTER TABLE "a" DROP CONSTRAINT "a_kind_check";${BREAK}`,
      `ALTER TABLE "a" ADD CONSTRAINT "a_kind_check" CHECK ("kind" IN ('x', 'y'));${BREAK}`,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm;${BREAK}`,
      `CREATE INDEX "renamed_at_idx" ON "a" ("renamed_at");`,
    ].join("\n");
    expect(lintMigration("f.sql", sql)).toEqual([]);
  });

  test("comments are not statements, but words in strings and DO blocks are", () => {
    const commented = [
      "-- We will DROP TABLE x later, and RENAME nothing now.",
      "/* ALTER TABLE a DROP COLUMN b; */",
      `CREATE TABLE "x" ("id" text);`,
    ].join("\n");
    expect(lintMigration("f.sql", commented)).toEqual([]);
    const dynamic = [
      `CREATE TABLE "x" ("id" text);${BREAK}`,
      "DO $$",
      "BEGIN",
      "  EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO %I', 'a', 'b', 'c');",
      "END $$;",
    ].join("\n");
    expect(lintMigration("f.sql", dynamic).map((f) => [f.line, f.rule])).toEqual([[2, "RENAME"]]);
    const tagged = ["DO $body$ BEGIN DROP TABLE a; END $body$;"].join("\n");
    expect(lintMigration("f.sql", tagged).map((f) => f.rule)).toEqual(["DROP TABLE"]);
  });

  test("without the word COLUMN, as Postgres allows, it is still caught", () => {
    const rule = (sql: string) => lintMigration("f.sql", sql).map((f) => f.rule);
    expect(rule(`ALTER TABLE "a" DROP "b";`)).toEqual(["DROP COLUMN"]);
    expect(rule(`ALTER TABLE "a" DROP IF EXISTS "b" CASCADE;`)).toEqual(["DROP COLUMN"]);
    expect(rule(`ALTER TABLE "a" ADD "c" text, DROP "b";`)).toEqual(["DROP COLUMN"]);
    expect(rule(`ALTER TABLE "a" ALTER "b" TYPE bigint;`)).toEqual(["ALTER COLUMN … TYPE"]);
    expect(rule(`ALTER TABLE "a" ADD "b" integer NOT NULL;`)).toEqual([
      "ADD COLUMN … NOT NULL without a DEFAULT",
    ]);
    // Not a column dropped, but a default, which an older API's inserts may rely on.
    expect(rule(`ALTER TABLE "a" ALTER "b" DROP NOT NULL, ALTER "c" DROP DEFAULT;`)).toEqual([
      "DROP DEFAULT",
    ]);
    expect(rule(`ALTER TABLE "a" ALTER "b" DROP NOT NULL;`)).toEqual([]);
    expect(rule(`ALTER TABLE "a" ADD CONSTRAINT "k" CHECK ("b" IS NOT NULL);`)).toEqual([]);
    expect(rule(`TRUNCATE "a";`)).toEqual(["TRUNCATE"]);
    expect(rule(`DROP MATERIALIZED VIEW "v";`)).toEqual(["DROP SCHEMA or VIEW"]);
  });

  test("a comment hidden by an escaped string or a dollar tag with a digit does not hide code", () => {
    const rule = (sql: string) => lintMigration("f.sql", sql).map((f) => f.rule);
    // Postgres: E'\' /* ' is a string, then DROP TABLE runs, then `-- */'` is a comment.
    expect(rule(`SELECT E'\\' /* '; DROP TABLE "x"; -- */'`)).toContain("DROP TABLE");
    // Postgres: two dollar-quoted strings around a DROP TABLE that runs.
    expect(rule(`SELECT $x1$ /* $x1$; DROP TABLE "x"; SELECT $x1$ */ $x1$;`)).toContain(
      "DROP TABLE",
    );
    // A name with a dollar in it opens no quote.
    expect(statements(`SELECT a$b$ FROM t; SELECT 1;`).length).toBe(2);
  });

  test("only the column's own DEFAULT or GENERATED clause lets ADD … NOT NULL pass", () => {
    const rule = (sql: string) => lintMigration("f.sql", sql).map((f) => f.rule);
    const flagged = ["ADD COLUMN … NOT NULL without a DEFAULT"];
    // The word in a name, a string, or an expression is not a clause.
    expect(rule(`ALTER TABLE "a" ADD COLUMN "default_plan" text NOT NULL;`)).toEqual(flagged);
    expect(rule(`ALTER TABLE "a" ADD COLUMN "default" text NOT NULL;`)).toEqual(flagged);
    expect(rule(`ALTER TABLE "a" ADD COLUMN "generated" integer NOT NULL;`)).toEqual(flagged);
    expect(rule(`ALTER TABLE "a" ADD COLUMN generated integer NOT NULL;`)).toEqual(flagged);
    expect(rule(`ALTER TABLE "a" ADD COLUMN "k" text NOT NULL CHECK ("k" <> 'default');`)).toEqual(
      flagged,
    );
    expect(
      rule(`ALTER TABLE "a" ADD COLUMN "k" text NOT NULL CHECK ("k" <> 'add k DEFAULT 1');`),
    ).toEqual(flagged);
    expect(
      rule(`ALTER TABLE "a" ADD COLUMN "k" text NOT NULL REFERENCES "generated" ("id");`),
    ).toEqual(flagged);
    // A real clause passes, wherever it sits among the column's constraints.
    expect(rule(`ALTER TABLE "a" ADD COLUMN "k" text NOT NULL DEFAULT 'x';`)).toEqual([]);
    expect(rule(`ALTER TABLE "a" ADD "k" numeric(10, 2) DEFAULT (1 + 2) NOT NULL;`)).toEqual([]);
    expect(
      rule(
        `ALTER TABLE "a" ADD COLUMN IF NOT EXISTS "k" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL;`,
      ),
    ).toEqual([]);
    // A NOT NULL inside a CHECK is not the column's.
    expect(rule(`ALTER TABLE "a" ADD COLUMN "k" text CHECK ("k" IS NOT NULL);`)).toEqual([]);
  });

  test("block comments nest as in Postgres", () => {
    const rule = (sql: string) => lintMigration("f.sql", sql).map((f) => [f.line, f.rule]);
    // Hidden: the DROP TABLE sits inside the outer comment, so Postgres never runs it.
    expect(rule(`/* outer /* inner */ DROP TABLE "x"; */\nSELECT 1;`)).toEqual([]);
    // Exposed: the comment ends at the second */, so the `--` before it is inside the comment
    // and the DROP TABLE after it runs. Stopping at the first */ would read `-- */ DROP …` as
    // a line comment and miss it.
    expect(rule(`/* a /* b */ -- */ DROP TABLE "x";`)).toEqual([[1, "DROP TABLE"]]);
    expect(rule(`/* a /* b */ c */ -- d\nDROP TABLE "x";`)).toEqual([[2, "DROP TABLE"]]);
    expect(statements(`/* a /* b */ c */ SELECT 1; SELECT 2;`).length).toBe(2);
  });

  test("a grandfathered migration that changes is linted again", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-lint-"));
    const file = "0025_canvases.sql";
    const original = readFileSync(join(DIR, file), "utf8");
    writeFileSync(join(dir, file), original);
    expect(lintMigrations(dir)).toEqual([]);
    writeFileSync(join(dir, file), `${original}\nALTER TABLE "x" DROP COLUMN "y";\n`);
    expect(lintMigrations(dir).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a semicolon inside a string or a dollar quote does not end the statement", () => {
    const sql = `INSERT INTO "a" VALUES ('x;y');\nDO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 'it''s';`;
    expect(statements(sql).map((s) => s.line)).toEqual([1, 2, 3]);
  });

  test("every migration on this branch passes, or is grandfathered with a reason", () => {
    expect(lintMigrations(DIR)).toEqual([]);
  });

  test("each grandfathered migration exists, breaks the rule, and says why", () => {
    for (const [file, reason] of Object.entries(GRANDFATHERED)) {
      expect(existsSync(join(DIR, file))).toBe(true);
      expect(lintMigration(file, readFileSync(join(DIR, file), "utf8")).length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(40);
    }
    expect(Object.keys(GRANDFATHERED_SHA256)).toEqual(Object.keys(GRANDFATHERED));
    expect(Object.keys(GRANDFATHERED)).toEqual([
      "0007_runner_protocol.sql",
      "0023_vercel_sandboxes.sql",
      "0025_canvases.sql",
    ]);
  });

  test("the script fails on a bad migration and names its line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-lint-"));
    await Bun.write(join(dir, "0099_bad.sql"), `CREATE TABLE "a" ("id" text);\nDROP TABLE "b";\n`);
    const run = await $`bun ${join(import.meta.dir, "migrations.ts")} ${dir}`.nothrow().quiet();
    rmSync(dir, { recursive: true, force: true });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "::error file=packages/db/migrations/0099_bad.sql,line=2::DROP TABLE takes away",
    );
  });
});

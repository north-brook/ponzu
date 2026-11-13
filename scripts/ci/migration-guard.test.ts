import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generatedPart,
  handWritten,
  type JournalEntry,
  judge,
  judgeTree,
  lockProblems,
  MIGRATIONS,
  type Migrations,
  ROOT,
  readMigrations,
  renumberAdvice,
  tablesOf,
} from "./migration-guard.ts";

const BREAK = "--> statement-breakpoint";
const LOCK = `-- hand-written (give up rather than queue live writes)\nSET LOCAL lock_timeout = '5s';${BREAK}`;
/** Main's migrations as they are in this checkout. */
const MAIN = readMigrations(join(ROOT, MIGRATIONS));
const N = MAIN.journal.entries.length;
const NUMBER = String(N).padStart(4, "0");
const NEWEST = Math.max(...MAIN.journal.entries.map((e) => e.when));

function clone(m: Migrations): Migrations {
  return structuredClone(m);
}

interface Next {
  tag?: string;
  sql?: string;
  when?: number;
  prevId?: string;
  id?: string;
}

/** `base` with one more migration, right in every way unless told otherwise. */
function withNext(base: Migrations, next: Next = {}): Migrations {
  const m = clone(base);
  const count = m.journal.entries.length;
  const tag = next.tag ?? `${String(count).padStart(4, "0")}_thing`;
  const last = m.journal.entries.at(-1) as JournalEntry;
  const prev = JSON.parse(m.files[`meta/${last.tag.slice(0, 4)}_snapshot.json`] as string).id;
  m.journal.entries.push({
    idx: count,
    version: "7",
    when: next.when ?? Math.max(...m.journal.entries.map((e) => e.when)) + 1000,
    tag,
    breakpoints: true,
  });
  m.files[`${tag}.sql`] =
    next.sql ?? `CREATE TABLE "things" ("id" text PRIMARY KEY NOT NULL, "at" timestamp);`;
  m.files[`meta/${tag.slice(0, 4)}_snapshot.json`] = JSON.stringify({
    id: next.id ?? crypto.randomUUID(),
    prevId: next.prevId ?? prev,
    tables: { "public.things": { name: "things" } },
  });
  m.files["meta/_journal.json"] = JSON.stringify(m.journal);
  return m;
}

const rules = (r: { problems: { rule: string }[] }) => r.problems.map((p) => p.rule);

describe("the tree on its own", () => {
  test("main's migrations agree with their journal and snapshot chain", () => {
    expect(judgeTree(MAIN)).toEqual([]);
    expect(judge(MAIN, MAIN)).toEqual({ added: [], problems: [] });
  });

  test("main's newest snapshot names its tables", () => {
    const tables = tablesOf(MAIN);
    expect(tables).toContain("users");
    expect(tables).toContain("canvases");
  });

  test("a SQL file the journal does not list is never applied, and fails", () => {
    const m = clone(MAIN);
    m.files[`${NUMBER}_forgotten.sql`] = "SELECT 1;";
    expect(judgeTree(m).map((p) => p.rule)).toEqual(["not in the journal"]);
  });

  test("a journal entry with no file or no snapshot fails", () => {
    const m = withNext(MAIN);
    delete m.files[`${NUMBER}_thing.sql`];
    delete m.files[`meta/${NUMBER}_snapshot.json`];
    expect(judgeTree(m).map((p) => p.rule)).toEqual(["missing file", "missing snapshot"]);
  });
});

describe("a change against main", () => {
  test("the next migration, made after main's newest and following its chain, passes", () => {
    const result = judge(MAIN, withNext(MAIN));
    expect(result.problems).toEqual([]);
    expect(result.added.map((e) => e.tag)).toEqual([`${NUMBER}_thing`]);
  });

  test("the live example: billing takes the number first, then email lands on it", () => {
    // #586 merges 0032_billing; #602 still has 0032_email where main's billing is.
    const main = withNext(MAIN, { tag: `${NUMBER}_billing`, sql: `${LOCK}\nSELECT 1;` });
    const email = withNext(MAIN, { tag: `${NUMBER}_email`, sql: `${LOCK}\nSELECT 2;` });
    const result = judge(main, email);
    expect(rules(result)).toContain("not after main");
    expect(rules(result)).toContain("renumber");
    expect(result.problems[0]?.message).toBe(
      `Main's migration ${N} is ${NUMBER}_billing; this change has ${NUMBER}_email there.`,
    );
  });

  test("both kept after a merge: two migrations with one number fail", () => {
    const main = withNext(MAIN, { tag: `${NUMBER}_billing`, sql: `${LOCK}\nSELECT 1;` });
    const both = clone(main);
    // A merge that kept both journal entries, each with its own number.
    both.journal.entries.push({
      idx: N + 1,
      version: "7",
      when: NEWEST + 5000,
      tag: `${NUMBER}_email`,
      breakpoints: true,
    });
    both.files[`${NUMBER}_email.sql`] = `${LOCK}\nSELECT 2;`;
    const result = judge(main, both);
    expect(rules(result)).toContain("number taken");
  });

  test("a renumbered migration whose snapshot still follows the old chain fails", () => {
    const result = judge(MAIN, withNext(MAIN, { prevId: crypto.randomUUID() }));
    expect(rules(result)).toEqual(["snapshot chain", "snapshot chain", "renumber"]);
  });

  test("a new snapshot with no id, or that is not JSON, fails", () => {
    for (const text of [JSON.stringify({ prevId: "x" }), "{ not json"]) {
      const m = withNext(MAIN);
      m.files[`meta/${NUMBER}_snapshot.json`] = text;
      expect(rules(judge(MAIN, m))).toContain("snapshot chain");
    }
    // Even when its prevId is right, the next one could not follow it.
    const prevId = JSON.parse(
      MAIN.files[`meta/${String(N - 1).padStart(4, "0")}_snapshot.json`] as string,
    ).id;
    const m = withNext(MAIN);
    m.files[`meta/${NUMBER}_snapshot.json`] = JSON.stringify({ prevId });
    expect(rules(judge(MAIN, m))).toEqual(["snapshot chain"]);
  });

  test("a migration made before main's newest fails: db:migrate would skip it", () => {
    const result = judge(MAIN, withNext(MAIN, { when: NEWEST - 1 }));
    expect(rules(result)).toEqual(["older than main's newest", "renumber"]);
  });

  test("more than one new migration fails", () => {
    const result = judge(MAIN, withNext(withNext(MAIN)));
    expect(rules(result)).toContain("more than one migration");
  });

  test("editing or deleting a migration main has fails", () => {
    const edited = clone(MAIN);
    edited.files["0031_search.sql"] += "\nSELECT 1;";
    expect(rules(judge(MAIN, edited))).toEqual(["applied migration changed"]);
    const gone = clone(MAIN);
    delete gone.files["0030_notifications.sql"];
    expect(rules(judge(MAIN, gone))).toContain("applied migration changed");
  });

  test("each kind of destructive statement fails as not expand only", () => {
    for (const statement of [
      `ALTER TABLE "users" DROP COLUMN "github_login";`,
      `DROP TABLE "devices";`,
      `ALTER TABLE "canvases" RENAME COLUMN "name" TO "title";`,
      `ALTER TABLE "canvases" ALTER COLUMN "seq" SET DATA TYPE integer;`,
      `ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;`,
      `ALTER TABLE "users" ADD COLUMN "plan" text NOT NULL;`,
    ]) {
      const result = judge(MAIN, withNext(MAIN, { sql: `${LOCK}\n${statement}` }));
      expect(rules(result)).toEqual(["not expand only"]);
    }
  });

  test("a column with a default, a nullable column or a new table is expand only", () => {
    for (const statement of [
      `ALTER TABLE "users" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;`,
      `ALTER TABLE "users" ADD COLUMN "plan" text;`,
      `CREATE TABLE "things" ("id" text PRIMARY KEY NOT NULL);`,
    ]) {
      expect(judge(MAIN, withNext(MAIN, { sql: `${LOCK}\n${statement}` })).problems).toEqual([]);
    }
  });
});

describe("the lock timeout", () => {
  const tables = tablesOf(MAIN);

  test("a statement on a table main has, with no lock_timeout before it, fails", () => {
    for (const sql of [
      `ALTER TABLE "users" ADD COLUMN "plan" text;`,
      `CREATE INDEX "users_plan_idx" ON "users" USING btree ("plan");`,
      `CREATE TABLE "things" ("user_id" text);${BREAK}\nALTER TABLE "things" ADD CONSTRAINT "f" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");`,
      `UPDATE users SET plan = 'free';`,
      `ALTER TABLE IF EXISTS users ADD COLUMN plan text;`,
      `ALTER TABLE IF EXISTS ONLY public.users ADD COLUMN plan text;`,
    ]) {
      const found = lockProblems("x.sql", sql, tables);
      expect(found.map((p) => p.rule)).toEqual(["lock_timeout"]);
    }
  });

  test("names the table and the line", () => {
    const sql = `CREATE TABLE "things" ("id" text);${BREAK}\nALTER TABLE "users" ADD COLUMN "plan" text;`;
    const [found] = lockProblems("x.sql", sql, tables);
    expect(found?.line).toBe(2);
    expect(found?.message).toStartWith(`This statement locks "users"`);
  });

  test("lock_timeout first passes, and a migration touching only new tables needs none", () => {
    const sql = `${LOCK}\nALTER TABLE "users" ADD COLUMN "plan" text;`;
    expect(lockProblems("x.sql", sql, tables)).toEqual([]);
    expect(lockProblems("x.sql", `SET lock_timeout = '2s';\nDROP INDEX "i";`, tables)).toEqual([]);
    const fresh = `CREATE TABLE "things" ("id" text PRIMARY KEY NOT NULL, "users_seen" integer);`;
    expect(lockProblems("x.sql", fresh, tables)).toEqual([]);
  });

  test("a lock_timeout of zero or DEFAULT is no timeout, and does not count", () => {
    for (const set of [
      "SET LOCAL lock_timeout = 0;",
      "SET LOCAL lock_timeout = '0';",
      "SET lock_timeout TO DEFAULT;",
      "SET LOCAL lock_timeout = '0s';",
    ]) {
      const sql = `${set}${BREAK}\nALTER TABLE "users" ADD COLUMN "plan" text;`;
      expect(lockProblems("x.sql", sql, tables).map((p) => p.rule)).toEqual(["lock_timeout"]);
    }
    for (const set of ["SET LOCAL lock_timeout TO '1min';", "SET SESSION lock_timeout = 5000;"]) {
      const sql = `${set}${BREAK}\nALTER TABLE "users" ADD COLUMN "plan" text;`;
      expect(lockProblems("x.sql", sql, tables)).toEqual([]);
    }
  });

  test("a lock_timeout set after the first lock is too late", () => {
    const sql = `ALTER TABLE "users" ADD COLUMN "plan" text;${BREAK}\nSET LOCAL lock_timeout = '5s';`;
    expect(lockProblems("x.sql", sql, tables).map((p) => p.rule)).toEqual(["lock_timeout"]);
  });

  test("main's newest migration, 0031_search, is the pattern and passes", () => {
    const before = clone(MAIN);
    before.journal.entries.pop();
    expect(
      lockProblems("0031_search.sql", MAIN.files["0031_search.sql"] as string, tablesOf(before)),
    ).toEqual([]);
  });
});

describe("renumbering", () => {
  const search = readFileSync(join(ROOT, MIGRATIONS, "0031_search.sql"), "utf8");

  test("finds the hand-written lines of 0031_search", () => {
    const lines = handWritten(search).map((chunk) => chunk.trim().split("\n").at(-1));
    expect(lines).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    ]);
  });

  test("what Drizzle wrote is the same with or without the hand-written lines", () => {
    const generated = search
      .split(BREAK)
      .filter((chunk) => !chunk.includes("-- hand-written"))
      .join(BREAK);
    expect(generatedPart(generated)).toBe(generatedPart(search));
    expect(generatedPart(search)).not.toContain("lock_timeout");
    expect(generatedPart(search)).toContain('CREATE TABLE "search_entries"');
  });

  test("the advice names the command and the base", () => {
    expect(renumberAdvice("abc123")).toContain(
      "bun scripts/ci/migration-guard.ts renumber --base abc123",
    );
  });

  test("judged against a commit in CI, the advice renumbers onto origin/main", () => {
    // A queue entry ahead may never land, and a lane has no copy of it.
    expect(renumberAdvice("a".repeat(40))).toContain(
      "bun scripts/ci/migration-guard.ts renumber --base origin/main",
    );
  });
});

describe("the command", () => {
  test("against this checkout's own commit, with no new migration, passes", async () => {
    const child = Bun.spawn(["bun", "scripts/ci/migration-guard.ts", "check", "--base", "HEAD"], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    // A checkout that is changing its migrations right now has one HEAD lacks.
    const dirty =
      JSON.stringify(MAIN.journal) !==
      JSON.stringify(
        JSON.parse(
          await Bun.$`git show HEAD:${MIGRATIONS}/meta/_journal.json`.cwd(ROOT).quiet().text(),
        ),
      );
    if (dirty) return;
    expect(code).toBe(0);
    expect(out).toContain("No new migration");
  });

  test("without a command it says how to use it", async () => {
    const child = Bun.spawn(["bun", "scripts/ci/migration-guard.ts"], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(2);
    expect(err).toContain("usage:");
  });
});

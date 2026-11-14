#!/usr/bin/env bun
/**
 * The old API on the new schema. A merge to main migrates first and deploys after, so for the
 * minutes a deploy takes (and for good after a rollback) the API that was live before the merge
 * runs against the schema this change's migration makes. This proves it can: it takes the base's
 * own code (main as it was before this change), puts this change's migrations in its place, and
 * runs the base's own tests of its database code there, which build every test database from
 * those migrations:
 *
 * - `packages/db`: every query the API calls (the API writes no SQL of its own), and, given
 *   `PONZU_TEST_DATABASE_URL`, its `*.live.test.ts` files on a real Postgres that this change's
 *   migrations were applied to by `db:migrate`;
 * - `apps/api`: the routes, jobs and the live queries clients subscribe to, on the test app.
 *
 * Left out: `packages/db/src/schema/`, whose tests are about the migrations themselves (that the
 * schema's TypeScript and the migrations agree, and that a migration is the newest), which is
 * true of this change's tree and not of the base's; the API's `*.surface.test.ts`, which read the
 * source tree through git and reach no database; and the API's `*.live.test.ts`, which reach
 * vendors.
 *
 * It replaces the hand-written "old API after the migration" tests that #552 and #602 carried
 * (`notifications-migration.test.ts`, `email-migration.test.ts`): those wrote by hand the rows
 * the old API inserts; this runs the old API's own code. A change with no new migration passes
 * at once.
 *
 *   bun scripts/ci/migration-contract.ts --base <ref> [--head <ref>]
 *
 * With `--head`, the change's migrations are read from that ref instead of the working tree, so
 * a pull request can be tried without checking it out.
 */
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  extractTree,
  MIGRATIONS,
  ROOT,
  readMigrations,
  readMigrationsAt,
} from "./migration-guard.ts";

/** Tests of the migrations themselves, true of this change's tree and not of the base's. */
export const MIGRATION_TESTS = "packages/db/src/schema/";

/** The base's test files to run, from its root, relative. */
export function contractTestFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of ["packages/db/src", "apps/api/src"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
      const file = relative(root, join(entry.parentPath, entry.name)).split("\\").join("/");
      if (file.startsWith(MIGRATION_TESTS)) continue;
      if (file.startsWith("apps/api/") && /\.(surface|live)\.test\.ts$/.test(file)) continue;
      files.push(file);
    }
  }
  return files.sort();
}

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

async function summary(text: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path)
    await Bun.write(
      path,
      `${
        (await Bun.file(path)
          .text()
          .catch(() => "")) + text
      }\n`,
    );
}

async function main(base: string, headRef?: string): Promise<number> {
  const head = headRef ? await readMigrationsAt(headRef) : readMigrations(join(ROOT, MIGRATIONS));
  const before = await readMigrationsAt(base);
  const added = head.journal.entries.slice(before.journal.entries.length).map((e) => e.tag);
  if (!added.length) {
    const said = `No new migration after ${base}: the API there already runs on this schema.`;
    console.log(said);
    await summary(`### The API before this change, on its schema\n\n${said}`);
    return 0;
  }

  const tree = await extractTree(base);
  try {
    rmSync(join(tree, MIGRATIONS), { recursive: true, force: true });
    if (headRef) {
      const from = await extractTree(headRef, [MIGRATIONS]);
      cpSync(join(from, MIGRATIONS), join(tree, MIGRATIONS), { recursive: true });
      rmSync(from, { recursive: true, force: true });
    } else {
      cpSync(join(ROOT, MIGRATIONS), join(tree, MIGRATIONS), { recursive: true });
    }
    const install = await run(
      // Everything, as the tests job installs it: the API's tests import from across the tree.
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      tree,
    );
    if (install !== 0) return install;

    const live = process.env.PONZU_TEST_DATABASE_URL;
    if (live) {
      // This change's migrations, applied as a deploy applies them, for the base's live tests.
      const migrated = await run(["bun", "src/migrate.ts"], join(tree, "packages/db"), {
        DATABASE_URL: live,
      });
      if (migrated !== 0) return migrated;
    } else {
      console.log(
        "::notice title=Postgres skipped::PONZU_TEST_DATABASE_URL is not set, so packages/db's live tests skip; the rest run on PGlite.",
      );
    }

    const files = contractTestFiles(tree);
    console.log(
      `The code at ${base} (${files.length} test files) on the schema ${added.join(", ")} makes.`,
    );
    // The PGlite tests side by side; the live ones share one Postgres, so one file at a time
    // (as the "Database on Postgres" job runs them), and only when there is a Postgres.
    const onPostgres = files.filter((f) => f.endsWith(".live.test.ts"));
    const onPglite = files.filter((f) => !f.endsWith(".live.test.ts"));
    const test = (args: string[], list: string[]) =>
      run(["bun", "test", ...args, "--timeout", "20000", ...list.map((f) => `./${f}`)], tree);
    let code = await test(["--parallel"], onPglite);
    if (live) code ||= await test([], onPostgres);
    await summary(
      `### The API before this change, on its schema\n\n${
        code === 0
          ? `The code at \`${base}\` passes its database and API tests (${files.length} files) on the schema ${added.join(", ")} makes, so the API live before this merge keeps working while the new one deploys.`
          : `The code at \`${base}\` FAILS its own tests on the schema ${added.join(", ")} makes: the API live before this merge would break between the migration and the deploy. Make the migration expand only.`
      }`,
    );
    if (code !== 0) {
      console.log(
        `::error title=The API before this change breaks on its schema::The code at ${base} fails its own tests once ${added.join(", ")} is applied. A merge migrates before the new API is live, so production would serve errors meanwhile. Keep what the old API reads and writes; add, never take away.`,
      );
    }
    return code;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const option = (name: string) => {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : undefined;
  };
  const base = option("--base");
  if (!base) {
    console.error("usage: bun scripts/ci/migration-contract.ts --base <ref> [--head <ref>]");
    process.exit(2);
  }
  process.exit(await main(base, option("--head")));
}

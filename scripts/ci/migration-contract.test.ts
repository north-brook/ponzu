import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { contractTestFiles, MIGRATION_TESTS } from "./migration-contract.ts";
import { MIGRATIONS, ROOT, readMigrations } from "./migration-guard.ts";

describe("which of the base's tests run on the new schema", () => {
  const files = contractTestFiles(ROOT);

  test("the database's queries and the API's routes, jobs and live queries", () => {
    for (const file of [
      "packages/db/src/queries/canvases.test.ts",
      "packages/db/src/queries/races.live.test.ts",
      "apps/api/src/live/queries.test.ts",
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(files).toContain(file);
    }
    expect(files.filter((f) => f.startsWith("apps/api/")).length).toBeGreaterThan(50);
    expect(files.filter((f) => f.startsWith("packages/db/")).length).toBeGreaterThan(30);
  });

  test("not the tests of the migrations themselves, nor those that reach vendors or git", () => {
    // These hold the schema's TypeScript to the migrations: true of the change, not the base.
    expect(existsSync(join(ROOT, MIGRATION_TESTS, "schema.test.ts"))).toBe(true);
    expect(files.some((f) => f.startsWith(MIGRATION_TESTS))).toBe(false);
    expect(files.some((f) => /^apps\/api\/.*\.(surface|live)\.test\.ts$/.test(f))).toBe(false);
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true);
  });
});

describe("the command", () => {
  test("with no new migration after the base, there is nothing to prove", async () => {
    // A checkout adding a migration right now would run the whole contract: that is CI's job.
    const head = await Bun.$`git show HEAD:${MIGRATIONS}/meta/_journal.json`
      .cwd(ROOT)
      .quiet()
      .text();
    const here = readMigrations(join(ROOT, MIGRATIONS)).journal;
    if (JSON.stringify(JSON.parse(head)) !== JSON.stringify(here)) return;
    const child = Bun.spawn(["bun", "scripts/ci/migration-contract.ts", "--base", "HEAD"], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(out).toContain("No new migration after HEAD");
  });
});

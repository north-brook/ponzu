/**
 * deploy-plan.ts on a real git history made in a temporary directory, as main grows by squash
 * merges: what is live, what changed since, and what GitHub's queue may skip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { behind, gitIn, liveCommit, plan } from "./deploy-plan.ts";

let dir: string;
const commits: Record<string, string> = {};

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return out.trim();
}

/** One squash merge to main: these files, then a commit named `name`. */
async function merge(name: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", name);
  commits[name] = await git("rev-parse", "HEAD");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "deploy-plan-"));
  await git("init", "-q", "-b", "main");
  await merge("W", { "apps/api/src/index.ts": "1", "docs/production.md": "1" });
  // A merge with a migration, then one of docs, then one of the studio and a test.
  await merge("A", {
    "packages/db/migrations/0032_billing.sql": "ALTER TABLE x ADD COLUMN y int;",
    "packages/db/migrations/meta/_journal.json": "{}",
  });
  await merge("B", { "docs/production.md": "2" });
  await merge("C", {
    "apps/studio/src/app/x.tsx": "1",
    "apps/api/src/routes/x.test.ts": "1",
  });
  await merge("D", { "apps/api/src/index.ts": "2" });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the plan", () => {
  test("a merge that changes nothing the API is made from deploys nothing", async () => {
    const result = await plan(commits.C!, [{ environment: "dev", commit: commits.B! }], gitIn(dir));
    expect(result.deploy).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.reasons[0]).toContain("nothing the API is made from changed");
  });

  test("a waiting run GitHub replaced skips no migration: the newest compares with what is live", async () => {
    // W is live; A (a migration) was waiting and was replaced by B (docs alone). B's plan still
    // sees A's migration, and B's checkout holds A's journal, so `db:migrate` applies it.
    const result = await plan(commits.B!, [{ environment: "dev", commit: commits.W! }], gitIn(dir));
    expect(result.deploy).toBe(true);
    expect(result.changes).toEqual([
      "packages/db/migrations/0032_billing.sql",
      "packages/db/migrations/meta/_journal.json",
    ]);
  });

  test("three in a row, with the middle two replaced, still ship everything since what is live", async () => {
    const result = await plan(commits.D!, [{ environment: "dev", commit: commits.W! }], gitIn(dir));
    expect(result.deploy).toBe(true);
    expect(result.changes).toEqual([
      "apps/api/src/index.ts",
      "packages/db/migrations/0032_billing.sql",
      "packages/db/migrations/meta/_journal.json",
    ]);
  });

  test("production behind dev deploys both, so production gets only what dev checked", async () => {
    // Dev took A; production failed at A and went back to W; then C (no API change) merges.
    const result = await plan(
      commits.C!,
      [
        { environment: "dev", commit: commits.A! },
        { environment: "production", commit: commits.W! },
      ],
      gitIn(dir),
    );
    expect(result.deploy).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });

  test("an older commit never replaces a newer one, even on a dispatch", async () => {
    for (const always of [false, true]) {
      const result = await plan(
        commits.B!,
        [{ environment: "dev", commit: commits.D! }],
        gitIn(dir),
        { always },
      );
      expect(result.deploy).toBe(false);
      expect(result.reasons[0]).toContain("newer than");
    }
  });

  test("what is live can't be read, or is not in main's history: deploy", async () => {
    const unread = await plan(commits.C!, [{ environment: "dev", commit: null }], gitIn(dir));
    expect(unread.deploy).toBe(true);
    const stranger = await plan(
      commits.C!,
      [{ environment: "dev", commit: "f".repeat(40) }],
      gitIn(dir),
    );
    expect(stranger.deploy).toBe(true);
  });

  test("the same commit live deploys nothing, unless asked by hand", async () => {
    const live = [{ environment: "dev", commit: commits.D! }];
    expect((await plan(commits.D!, live, gitIn(dir))).deploy).toBe(false);
    expect((await plan(commits.D!, live, gitIn(dir), { always: true })).deploy).toBe(true);
  });
});

describe("the guard before the database", () => {
  test("an older run started again never goes backwards, on dev or production", async () => {
    // "Re-run failed jobs" on B's run after D's run has deployed: B's plan said deploy, and is
    // not asked again, so the job itself refuses.
    for (const environment of ["dev", "production"]) {
      const problem = await behind(commits.B!, { environment, commit: commits.D! }, gitIn(dir));
      expect(problem).toContain(`${environment} serves`);
      expect(problem).toContain("newer than");
    }
  });

  test("the same commit, an older one, an unreadable one or a stranger may go", async () => {
    for (const commit of [commits.D!, commits.B!, null, "f".repeat(40)])
      expect(await behind(commits.D!, { environment: "dev", commit }, gitIn(dir))).toBeNull();
  });
});

describe("what is live", () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("is the commit health names, or null", async () => {
    const sha = "a".repeat(40);
    expect(await liveCommit("https://x.test", answer(200, { commit: sha }))).toBe(sha);
    expect(await liveCommit("https://x.test", answer(200, { commit: null }))).toBeNull();
    expect(await liveCommit("https://x.test", answer(200, { commit: "main" }))).toBeNull();
    expect(await liveCommit("https://x.test", answer(503, "down"))).toBeNull();
    const fails = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await liveCommit("https://x.test", fails)).toBeNull();
  });
});

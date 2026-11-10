import { afterAll, beforeAll, expect, test } from "bun:test";
import { getWorkspaceByInstallation, repos, workspaces } from "@ponzu/db";
import { syncGithub } from "../github/sync.ts";
import {
  createTestApp,
  type FakeInstallation,
  TEST_CRON_SECRET,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const run = (authorization?: string) =>
  t.app.request("/v1/cron/minute", { headers: authorization ? { authorization } : {} });

test("only the scheduler's secret runs it", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${TEST_CRON_SECRET}x`]) {
    const response = await run(authorization);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  }
  const response = await run(`Bearer ${TEST_CRON_SECRET}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ran: 0, abandoned: 0, swept: 0 });
});

test("installations nobody has read for hours are read again, which catches a lost uninstall", async () => {
  const una = await t.signInAs({ login: "una" });
  const installation: FakeInstallation = {
    id: 60_001,
    account: { id: 60_002, login: "sweptco", type: "Organization", members: [una.github.id] },
    repositorySelection: "selected",
    repositories: [{ id: 60_003, fullName: "sweptco/app", access: { [una.github.id]: "write" } }],
  };
  t.github.installations.push(installation);
  const [workspace] = await syncGithub(t.deps, una.userId);

  // Still fresh: nothing to read.
  expect(await (await run(`Bearer ${TEST_CRON_SECRET}`)).json()).toMatchObject({ swept: 0 });

  // Removed from GitHub, and its webhook never arrived. Hours pass.
  t.github.installations.pop();
  t.clock.advance(6 * 3600_000 + 60_000);
  expect(await (await run(`Bearer ${TEST_CRON_SECRET}`)).json()).toMatchObject({ swept: 1 });

  expect(await getWorkspaceByInstallation(t.db, installation.id)).toBeNull();
  const [row] = (await t.db.select().from(workspaces)).filter((w) => w.id === workspace!.id);
  expect(row!.installationId).toBeNull();
  const [repo] = (await t.db.select().from(repos)).filter((r) => r.workspaceId === workspace!.id);
  expect(repo!.removedAt).toBeInstanceOf(Date);
  // Gone, it is not read again.
  expect(await (await run(`Bearer ${TEST_CRON_SECRET}`)).json()).toMatchObject({ swept: 0 });
});

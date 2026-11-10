import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { createDesign, getDesign } from "./designs.ts";
import { findDesignByBranch, recordPullRequest } from "./pull-requests.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function designOnBranch(branch = "pz/checkout") {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const repo = await seedRepo(db, workspace.id, `${workspace.githubLogin}/app`);
  const design = await createDesign(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Checkout",
    branch,
    doc: emptyDoc("Checkout"),
  });
  return { design, key: { githubRepoId: repo.githubRepoId, branch } };
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 12, minute));

test("findDesignByBranch finds the design that owns a branch, and only that", async () => {
  const { design, key } = await designOnBranch();

  expect(await findDesignByBranch(db, key)).toEqual({ id: design.id, status: "active" });
  expect(await findDesignByBranch(db, { ...key, branch: "main" })).toBeNull();
  expect(await findDesignByBranch(db, { ...key, githubRepoId: 404_404 })).toBeNull();
});

test("the newest word on a pull request wins, whatever order it arrives in", async () => {
  const { design, key } = await designOnBranch();
  const record = (minute: number, state: "open" | "closed" | "draft") =>
    recordPullRequest(db, { ...key, number: 7, state, updatedAt: at(minute) });

  expect(await record(1, "draft")).toBe(design.id);
  expect(await record(5, "closed")).toBe(design.id);
  // Reopened at minute 3, delivered after the close at minute 5: stale.
  expect(await record(3, "open")).toBeNull();
  expect(await getDesign(db, design.id)).toMatchObject({
    prNumber: 7,
    prState: "closed",
    prUpdatedAt: at(5),
    status: "active",
  });

  // The same delivery again changes nothing and is not refused.
  expect(await record(5, "closed")).toBe(design.id);
});

test("a later pull request from the same branch replaces an earlier one", async () => {
  const { design, key } = await designOnBranch();
  await recordPullRequest(db, { ...key, number: 7, state: "closed", updatedAt: at(9) });

  expect(await recordPullRequest(db, { ...key, number: 8, state: "open", updatedAt: at(2) })).toBe(
    design.id,
  );
  // And the earlier one cannot take it back.
  expect(
    await recordPullRequest(db, { ...key, number: 7, state: "open", updatedAt: at(30) }),
  ).toBeNull();
  expect(await getDesign(db, design.id)).toMatchObject({ prNumber: 8, prState: "open" });
});

test("a merge settles the design, once", async () => {
  const { design, key } = await designOnBranch();

  await recordPullRequest(db, { ...key, number: 3, state: "merged", updatedAt: at(1) });
  const settled = await getDesign(db, design.id);
  await recordPullRequest(db, { ...key, number: 3, state: "merged", updatedAt: at(2) });

  expect(settled).toMatchObject({ status: "settled", prState: "merged" });
  expect(settled!.settledAt).toBeInstanceOf(Date);
  expect((await getDesign(db, design.id))!.settledAt).toEqual(settled!.settledAt);
});

test("a branch no design owns records nothing", async () => {
  const { key } = await designOnBranch();
  expect(
    await recordPullRequest(db, {
      ...key,
      branch: "feature",
      number: 1,
      state: "open",
      updatedAt: at(1),
    }),
  ).toBeNull();
});

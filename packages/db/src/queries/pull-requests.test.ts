import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { createDesign, getDesign, settleDesign } from "./designs.ts";
import {
  findDesignByBranch,
  getPullRequestContext,
  listDesignsWithOpenPullRequests,
  type PullRequestRead,
  recordPullRequestRead,
  setPullRequestSummary,
} from "./pull-requests.ts";

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
  return { design, repo, user, key: { githubRepoId: repo.githubRepoId, branch } };
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, second));

/** A read of pull request 7, begun at `second`. */
const read = (
  designId: string,
  second: number,
  fields: Partial<PullRequestRead> = {},
): PullRequestRead => ({
  designId,
  number: 7,
  state: "open",
  checks: "running",
  mergeable: null,
  autoMerge: false,
  updatedAt: at(0),
  readAt: at(second),
  ...fields,
});

test("findDesignByBranch finds the design that owns a branch, and only that", async () => {
  const { design, key } = await designOnBranch();

  expect(await findDesignByBranch(db, key)).toMatchObject({
    id: design.id,
    status: "active",
    repo: { githubRepoId: key.githubRepoId },
  });
  expect(await findDesignByBranch(db, { ...key, branch: "main" })).toBeNull();
  expect(await findDesignByBranch(db, { ...key, githubRepoId: 404_404 })).toBeNull();
});

test("the read that began last wins, whatever order the reads finish in", async () => {
  const { design } = await designOnBranch();

  expect(await recordPullRequestRead(db, read(design.id, 1))).toMatchObject({
    prChecks: "running",
  });
  expect(
    await recordPullRequestRead(db, read(design.id, 5, { checks: "passing", mergeable: true })),
  ).toMatchObject({ prChecks: "passing", prMergeable: true });
  // Begun at second 3, finished after the one begun at 5. GitHub's updatedAt is the same for
  // both: a check finishing does not move it.
  expect(await recordPullRequestRead(db, read(design.id, 3))).toBeNull();
  expect(await getDesign(db, design.id)).toMatchObject({
    prNumber: 7,
    prState: "open",
    prChecks: "passing",
    prMergeable: true,
    prReadAt: at(5),
    status: "active",
  });
});

test("a later pull request from the same branch replaces an earlier one", async () => {
  const { design } = await designOnBranch();
  await recordPullRequestRead(db, read(design.id, 9, { state: "closed" }));

  expect(await recordPullRequestRead(db, read(design.id, 2, { number: 8 }))).toMatchObject({
    prNumber: 8,
  });
  // And the earlier one cannot take it back.
  expect(await recordPullRequestRead(db, read(design.id, 30, { state: "open" }))).toBeNull();
  expect(await getDesign(db, design.id)).toMatchObject({ prNumber: 8, prState: "open" });
});

test("a merge settles the design and is the last word on its pull request", async () => {
  const { design } = await designOnBranch();

  const merged = await recordPullRequestRead(
    db,
    read(design.id, 1, { state: "merged", checks: "passing" }),
  );
  expect(merged).toMatchObject({ status: "settled", prState: "merged" });
  expect(merged!.settledAt).toEqual(at(1));

  // Someone reopens the design; a later read of the merged pull request leaves it open.
  await settleDesign(db, design.id, { settled: false, now: at(2) });
  expect(await recordPullRequestRead(db, read(design.id, 3, { state: "merged" }))).toBeNull();
  expect(await getDesign(db, design.id)).toMatchObject({ status: "active", prState: "merged" });
});

test("the open pull requests of a repo are those of its active designs", async () => {
  const { design, repo, user } = await designOnBranch("pz/a");
  const other = await createDesign(db, {
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Other",
    branch: "pz/b",
    doc: emptyDoc("Other"),
  });
  const closed = await createDesign(db, {
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Closed",
    branch: "pz/c",
    doc: emptyDoc("Closed"),
  });
  await recordPullRequestRead(db, read(design.id, 1, { state: "draft" }));
  await recordPullRequestRead(db, read(other.id, 1, { number: 8 }));
  await recordPullRequestRead(db, read(closed.id, 1, { number: 9, state: "closed" }));

  expect((await listDesignsWithOpenPullRequests(db, repo.githubRepoId)).sort()).toEqual(
    [design.id, other.id].sort(),
  );
});

test("the context has the repo it opens in, and the summary waits in the row", async () => {
  const { design, repo } = await designOnBranch();

  expect(await setPullRequestSummary(db, { designId: design.id, summary: "Shorter." })).toEqual({
    prNumber: null,
    prState: null,
  });
  const context = await getPullRequestContext(db, design.id);
  expect(context).toMatchObject({
    design: { id: design.id, prSummary: "Shorter." },
    repo: { githubRepoId: repo.githubRepoId, fullName: repo.fullName, defaultBranch: "main" },
  });
  expect(context!.assetKey).toBeString();
  expect(await getPullRequestContext(db, "des_none")).toBeNull();
});

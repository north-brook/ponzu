import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { createCanvas, enqueueJob, getCanvas, jobs } from "@ponzu/db";
import { call, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import {
  createTestApp,
  type FakeRepoAccess,
  MERGEABLE_AFTER_MS,
  TEST_CRON_SECRET,
  type TestApp,
} from "../testing/index.ts";
import { REFRESH_JOB } from "./refresh.ts";
import { SWEEP_STALE_MS, sweepPullRequests } from "./sweep.ts";

/*
 * The sweep for pull requests whose webhooks were all lost (docs/cloud.md, "Pull requests"),
 * through the minute's cron, on PGlite and the fake GitHub.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const MINUTE = 60_000;
let branches = 0;

/** A canvas of Maya's with its pull request opened through Ponzu and read once. */
async function openPullRequest(ws?: Workspace) {
  const workspace = ws ?? (await workspaceWithRepo(t, { maya: "write" }));
  const repo = t.github.repo(workspace.repo.fullName)!;
  const branch = `pz/swept-${++branches}`;
  const canvas = await createCanvas(t.db, {
    workspaceId: workspace.id,
    repoId: workspace.repo.id,
    ownerId: workspace.people.maya!.userId,
    claudeAccountId: null,
    name: "Swept",
    branch,
    doc: emptyDoc("Swept"),
  });
  t.github.pulls.push(repo, branch);
  const opened = await call(
    t,
    workspace.people.maya!.headers,
    "POST",
    `/v1/canvases/${canvas.id}/pull-request`,
  );
  expect(opened.status).toBe(201);
  await t.backgroundDone();
  const pull = t.github.pulls.latest(repo)!;
  return { ws: workspace, repo, canvas, pull, branch };
}

/** Merged on GitHub by someone else, and every webhook about it lost. */
function mergedOnGithub(repo: FakeRepoAccess, pull: ReturnType<typeof t.github.pulls.latest>) {
  pull!.mergedHead = t.github.pulls.head(repo, pull!.head) ?? null;
  pull!.state = "closed";
  pull!.merged = true;
  pull!.mergedBy = "sam";
  pull!.closedAt = t.clock.now();
  pull!.updatedAt = t.clock.now();
}

const cron = async () => {
  const response = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { steps: Record<string, Record<string, number>> }).steps;
};

/** The reads of a canvas's pull request still waiting to run. */
const waiting = async (canvasId: string) =>
  (await t.db.select().from(jobs)).filter(
    (job) =>
      job.kind === REFRESH_JOB &&
      job.completedAt === null &&
      job.failedAt === null &&
      (job.payload as { canvasId?: string }).canvasId === canvasId,
  );

test("a pull request merged on GitHub with every webhook lost settles its canvas within the window", async () => {
  const { canvas, repo, pull } = await openPullRequest();
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prState: "draft", status: "active" });
  mergedOnGithub(repo, pull);

  // Read a moment ago: not stale yet, so nothing is read again.
  t.clock.advance(5 * MINUTE);
  expect((await cron()).pull_requests).toEqual({ swept: 0 });
  expect(await waiting(canvas.id)).toEqual([]);

  // A quarter of an hour unread: the sweep records a read, which the next minute's jobs make.
  t.clock.advance(SWEEP_STALE_MS);
  expect((await cron()).pull_requests).toEqual({ swept: 1 });
  expect(await waiting(canvas.id)).toHaveLength(1);
  expect(t.logs.find((line) => line.event === "pr_swept")).toMatchObject({ count: 1 });

  t.clock.advance(MINUTE);
  const next = await cron();
  expect(next.jobs?.ran).toBeGreaterThanOrEqual(1);
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prState: "merged", status: "settled" });
  // Merged is not open: never read again.
  expect(next.pull_requests).toEqual({ swept: 0 });
  t.clock.advance(SWEEP_STALE_MS + MINUTE);
  expect((await cron()).pull_requests).toEqual({ swept: 0 });
});

test("a quiet open pull request is read once a window, and one with a read waiting is left to it", async () => {
  const { canvas } = await openPullRequest();
  t.clock.advance(SWEEP_STALE_MS + MERGEABLE_AFTER_MS);
  const now = () => new Date(t.clock.now());

  // A webhook's read is already waiting for this canvas: the sweep leaves it.
  const webhook = await enqueueJob(t.db, {
    kind: REFRESH_JOB,
    key: `${canvas.id}@${t.clock.now() + 2_000}`,
    payload: { canvasId: canvas.id, number: 1 },
    runAt: new Date(t.clock.now() + 60 * MINUTE),
  });
  expect(webhook).not.toBeNull();
  expect(await sweepPullRequests(t.deps, now())).toBe(0);
  await t.db.execute(`update jobs set completed_at = now() where id = '${webhook!.id}'`);

  // Swept once this window; the read finds nothing new, so the canvas still looks stale, but the
  // window's mark keeps the next minutes off it.
  expect(await sweepPullRequests(t.deps, now())).toBe(1);
  await cron();
  expect(await waiting(canvas.id)).toEqual([]);
  t.clock.advance(MINUTE);
  expect(await sweepPullRequests(t.deps, now())).toBe(0);
  // The next window reads it again.
  t.clock.advance(SWEEP_STALE_MS);
  expect(await sweepPullRequests(t.deps, now())).toBe(1);
  await cron();
});

test("quiet pull requests read this window make way for the next oldest, not the same ones again", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const first = await openPullRequest(ws);
  t.clock.advance(MINUTE);
  const second = await openPullRequest(ws);
  // Start at a window's beginning, so both sweeps below fall in one window.
  t.clock.advance(SWEEP_STALE_MS + MINUTE);
  t.clock.advance(SWEEP_STALE_MS - (t.clock.now() % SWEEP_STALE_MS));
  const now = () => new Date(t.clock.now());
  // Earlier tests' canvases read just now, so only these two are stale.
  await t.db.execute(
    `update canvases set pr_read_at = '${now().toISOString()}' where id not in ('${first.canvas.id}', '${second.canvas.id}')`,
  );

  expect(await sweepPullRequests(t.deps, now(), { limit: 1 })).toBe(1);
  expect((await waiting(first.canvas.id)).length).toBe(1);
  // Its read runs and finds nothing new: still the oldest read, but already taken this window.
  t.clock.advance(MINUTE);
  await t.db.execute(
    `update jobs set completed_at = now() where kind = '${REFRESH_JOB}' and completed_at is null and failed_at is null`,
  );
  expect(await sweepPullRequests(t.deps, now(), { limit: 1 })).toBe(1);
  expect((await waiting(second.canvas.id)).length).toBe(1);
});

test("at most the limit a run, oldest read first, and never for a workspace GitHub can't be asked about", async () => {
  // The earlier tests' canvases are swept now, and their reads left waiting (no minute runs them
  // below), so the sweep leaves them out of what follows.
  t.clock.advance(SWEEP_STALE_MS);
  await cron();
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const first = await openPullRequest(ws);
  t.clock.advance(MINUTE);
  const second = await openPullRequest(ws);
  t.clock.advance(MINUTE);
  const third = await openPullRequest(ws);
  // All three unread for more than a quarter of an hour.
  t.clock.advance(SWEEP_STALE_MS + MINUTE);
  const now = () => new Date(t.clock.now());

  expect(await sweepPullRequests(t.deps, now(), { limit: 2 })).toBe(2);
  expect((await waiting(first.canvas.id)).length).toBe(1);
  expect((await waiting(second.canvas.id)).length).toBe(1);
  expect(await waiting(third.canvas.id)).toEqual([]);
  // The next minute goes on to the one left.
  expect(await sweepPullRequests(t.deps, now(), { limit: 2 })).toBe(1);
  expect((await waiting(third.canvas.id)).length).toBe(1);
  await cron();

  // The App suspended on the workspace: nothing to read it with, so nothing is recorded.
  t.clock.advance(MINUTE);
  await cron();
  for (const { canvas } of [first, second, third]) expect(await waiting(canvas.id)).toEqual([]);
  await t.db.execute(`update workspaces set suspended_at = now() where id = '${ws.id}'`);
  t.clock.advance(SWEEP_STALE_MS);
  await sweepPullRequests(t.deps, now(), { limit: 100 });
  for (const { canvas } of [first, second, third]) expect(await waiting(canvas.id)).toEqual([]);
});

test("an open linked pull request is swept too, in the same budget, and settles its canvas", async () => {
  // The earlier tests' reads left waiting are out of the way.
  t.clock.advance(SWEEP_STALE_MS);
  await cron();
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const canvas = await createCanvas(t.db, {
    workspaceId: ws.id,
    repoId: ws.repo.id,
    ownerId: ws.people.maya!.userId,
    claudeAccountId: null,
    name: "Linked",
    branch: `pz/swept-${++branches}`,
    doc: emptyDoc("Linked"),
  });
  const repo = t.github.repo(ws.repo.fullName)!;
  t.github.pulls.push(repo, "feature/linked");
  const pull = t.github.pulls.openAsSomeone(repo, { head: "feature/linked", login: "sam" });
  const linked = await call(
    t,
    ws.people.maya!.headers,
    "POST",
    `/v1/canvases/${canvas.id}/pull-requests`,
    {
      urls: [`https://github.com/${ws.repo.fullName}/pull/${pull.number}`],
    },
  );
  expect(linked.body.results[0]).toMatchObject({ result: "linked" });
  mergedOnGithub(repo, pull);

  t.clock.advance(SWEEP_STALE_MS + MINUTE);
  expect(
    await sweepPullRequests(t.deps, new Date(t.clock.now()), { limit: 100 }),
  ).toBeGreaterThanOrEqual(1);
  const reads = (await waiting(canvas.id)).filter(
    (job) => (job.payload as { repoId?: string }).repoId === ws.repo.id,
  );
  expect(reads).toHaveLength(1);
  expect(reads[0]!.key).toStartWith(`sweep:link:${canvas.id}:${ws.repo.id}:${pull.number}:`);
  // Taken this window: not again.
  expect((await waiting(canvas.id)).length).toBe(1);
  await sweepPullRequests(t.deps, new Date(t.clock.now()), { limit: 100 });
  expect(await waiting(canvas.id)).toHaveLength(1);

  t.clock.advance(MINUTE);
  await cron();
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prLinkedOpen: 0, status: "settled" });
});

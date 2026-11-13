import { beforeEach, expect, test } from "bun:test";
import { ApiError, type PullRequestTab } from "@ponzu/client";
import { toPullRequestDetail } from "@ponzu/client/model";
import type { PullRequestAction } from "@ponzu/client/query";
import { fakeWorld } from "./cloud/backend.fake";
import { PR } from "./copy";
import { checksLine, PrActions, prFoot, reviewsLine } from "./pull-request";

/*
 * The pull request sheet's rules, over the client's fake GitHub (FakePullRequests, which answers
 * `nextAction` as the API does): each state's foot, the status card's rows, and what a press
 * does, a double tap and a refused merge included.
 */

let world: ReturnType<typeof fakeWorld>;
let canvasId: string;
const api = () => world.fake.connect(world.maya).api;
const github = () => world.fake.canvas(canvasId).github!;
const tab = () => api().canvases.pullRequest.get(canvasId);

/** The Pricing page with a pull request open and ready, its checks as given. */
async function opened() {
  world.fake.agent(canvasId).push([{ path: "src/plans.tsx", additions: 4, deletions: 1 }]);
  await api().canvases.pullRequest.open(canvasId);
  await api().canvases.pullRequest.ready(canvasId);
}

beforeEach(async () => {
  world = fakeWorld();
  await world.ready;
  canvasId = [...world.fake.canvases.values()].find(
    (c) => c.sequencer.doc.name === "Pricing page",
  )!.id;
});

const foot = async (readOnly: string | null = null) =>
  prFoot(await tab(), { readOnly, asked: null });

test("each state's one action at the foot, as the API names it", async () => {
  // No pull request yet: Create PR is the Mac's, so nothing.
  world.fake.agent(canvasId).push();
  expect(await foot()).toBeNull();
  await api().canvases.pullRequest.open(canvasId);
  expect(await foot()).toMatchObject({ kind: "action", action: "ready", label: "Ready" });
  await api().canvases.pullRequest.ready(canvasId);
  expect(await foot()).toMatchObject({ action: "merge", label: "Merge", enabled: true });

  github().setChecks([{ name: "ci / test", state: "running", required: true }]);
  expect(await foot()).toMatchObject({ action: "auto_merge", label: "Auto-merge", enabled: true });
  await api().canvases.pullRequest.autoMerge(canvasId, true);
  expect(await foot()).toMatchObject({
    action: "auto_merge_on",
    enabled: false,
    note: "Merges once the checks pass",
  });

  github().setChecks([{ name: "ci / test", state: "failed" }]);
  expect(await foot()).toMatchObject({ action: "fix_checks", label: "Fix checks" });
  github().baseChanged({ conflicts: true });
  expect(await foot()).toMatchObject({ action: "resolve", label: "Resolve" });
});

test("behind with the rules wanting it up to date: Update branch", async () => {
  await opened();
  github().protect({ upToDate: true });
  github().baseChanged();
  expect(await foot()).toMatchObject({ action: "update_branch", label: "Update branch" });
});

test("held back by the rules with no auto-merge: the Mac's line, and nothing to press", async () => {
  await opened();
  github().autoMergeAllowed = false;
  github().protect({ review: true });
  expect(await foot()).toEqual({
    kind: "line",
    text: "This needs the Mac to merge past the review the repo's rules want.",
  });
  github().review("theo", "changes_requested");
  expect(await foot()).toEqual({
    kind: "line",
    text: "This needs the Mac to merge past a request for changes.",
  });
});

test("merged: no button; read only: the read-only line in its place", async () => {
  await opened();
  expect(await foot("You can look at this canvas.")).toEqual({
    kind: "line",
    text: "You can look at this canvas.",
  });
  const t = await tab();
  await api().canvases.pullRequest.merge(canvasId, { headSha: t.pullRequest!.head.sha });
  expect(await foot()).toBeNull();
});

test("the status card's rows", async () => {
  await opened();
  const rows = async () => {
    const pr = toPullRequestDetail((await tab()).pullRequest!);
    return { checks: checksLine(pr.checks, pr.state), reviews: reviewsLine(pr.reviews, "maya") };
  };
  expect((await rows()).checks).toEqual({ glyph: "queued", text: "No checks have reported" });
  github().setChecks([
    { name: "a", state: "passed" },
    { name: "b", state: "running" },
    { name: "c", state: "pending" },
  ]);
  expect((await rows()).checks).toEqual({ glyph: "running", text: "1 of 3 checks finished" });
  github().setChecks([
    { name: "a", state: "passed" },
    { name: "b", state: "skipped" },
  ]);
  expect((await rows()).checks).toEqual({ glyph: "passing", text: "2 checks passed" });
  github().setChecks([
    { name: "a", state: "failed" },
    { name: "b", state: "cancelled" },
  ]);
  expect((await rows()).checks).toEqual({ glyph: "failing", text: "2 checks failed" });

  expect((await rows()).reviews).toBeNull();
  github().review("theo", "approved");
  expect((await rows()).reviews?.text).toBe("theo approved");
  github().review("ana", "approved");
  expect((await rows()).reviews?.text).toMatch(/^(theo|ana) and 1 other approved$/);
  github().review("maya", "changes_requested");
  expect((await rows()).reviews?.text).toBe("You requested changes");
});

/** PrActions over the fake, with what it did written down. */
function actions(opts: { confirm?: boolean; failMerge?: unknown; failTell?: unknown } = {}) {
  const acted: PullRequestAction[] = [];
  const told: string[] = [];
  const asked: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prActions = new PrActions({
    act: async (request) => {
      acted.push(request);
      const pr = api().canvases.pullRequest;
      if (request.kind === "merge") {
        if (opts.failMerge) throw opts.failMerge;
        return pr.merge(canvasId, { headSha: request.headSha });
      }
      if (request.kind === "ready") return pr.ready(canvasId);
      if (request.kind === "auto_merge") return pr.autoMerge(canvasId, request.on);
      if (request.kind === "update_branch") {
        return pr.updateBranch(canvasId, { headSha: request.headSha });
      }
      throw new Error(`not offered: ${request.kind}`);
    },
    tell: async (text) => {
      if (opts.failTell) throw opts.failTell;
      told.push(text);
    },
    confirm: async (question) => {
      asked.push(question);
      await held;
      return opts.confirm ?? true;
    },
  });
  return { prActions, acted, told, asked, release };
}

test("Merge asks first, then merges once, with the commit that was looked at", async () => {
  await opened();
  const t: PullRequestTab = await tab();
  const { prActions, acted, asked, release } = actions();
  const first = prActions.run("merge", t);
  // A second tap while the question is up, and a third: nothing more.
  await prActions.run("merge", t);
  await prActions.run("merge", t);
  expect(asked).toEqual([`Merge #${t.pullRequest!.number} into main?`]);
  expect(prActions.getSnapshot().busy).toBe("merge");
  release();
  await first;
  expect(acted).toEqual([{ kind: "merge", headSha: t.pullRequest!.head.sha }]);
  expect(prActions.getSnapshot()).toMatchObject({ busy: null, failed: null });
  expect((await tab()).pullRequest!.state).toBe("merged");
});

test("Cancel merges nothing", async () => {
  await opened();
  const { prActions, acted, release } = actions({ confirm: false });
  const run = prActions.run("merge", await tab());
  release();
  await run;
  expect(acted).toEqual([]);
  expect(prActions.getSnapshot().busy).toBeNull();
});

test("a push while the question is up: the API refuses the old commit, and the line says why", async () => {
  await opened();
  const before = await tab();
  const { prActions, acted, release } = actions();
  const run = prActions.run("merge", before);
  github().push([{ path: "src/faq.tsx" }]);
  release();
  await run;
  expect(acted).toEqual([{ kind: "merge", headSha: before.pullRequest!.head.sha }]);
  expect(prActions.getSnapshot().failed).toBe(
    "The branch has new commits since you looked. Look again first.",
  );
  expect((await tab()).pullRequest!.state).toBe("open");
});

test("a refusal the API gives no words for, and a billing wall, in plain words", async () => {
  await opened();
  const t = await tab();
  const network = actions({ failMerge: new ApiError(0, "network", "fetch failed") });
  const run = network.prActions.run("merge", t);
  network.release();
  await run;
  expect(network.prActions.getSnapshot().failed).toBe(
    "Ponzu can't be reached. Check your connection and try again.",
  );

  github().setChecks([{ name: "ci / test", state: "failed" }]);
  // Billing's own codes come with its gate (W6 B2); the phone reads the status alone.
  const billing = "credits_used_up" as ConstructorParameters<typeof ApiError>[1];
  const wall = actions({
    failTell: new ApiError(402, billing, "Acme is at its cap. Add a card on your Mac."),
  });
  await wall.prActions.run("fix_checks", await tab());
  // The neutral first sentence, and nothing about paying.
  expect(wall.prActions.getSnapshot().failed).toBe("Acme is at its cap. This canvas waits.");
});

test("Fix checks and Resolve ask the agent in the Mac's words, once for a commit", async () => {
  await opened();
  github().setChecks([
    { name: "ci / test", state: "failed" },
    { name: "ci / lint", state: "passed" },
  ]);
  const { prActions, told } = actions();
  await prActions.run("fix_checks", await tab());
  await prActions.run("fix_checks", await tab());
  expect(told).toEqual(["Fix the failing checks on the pull request (ci / test) and push."]);
  // The foot says it was asked, and can't be pressed again for this commit.
  expect(prFoot(await tab(), { readOnly: null, asked: prActions.getSnapshot().asked })).toEqual({
    kind: "action",
    action: "fix_checks",
    label: PR.actions.fix_checks,
    enabled: false,
    note: PR.asked,
  });
  // A push moves the head: it may be asked again.
  github().push([{ path: "src/plans.tsx" }]);
  github().setChecks([{ name: "ci / test", state: "failed" }]);
  await prActions.run("fix_checks", await tab());
  expect(told).toHaveLength(2);

  github().baseChanged({ conflicts: true });
  await prActions.run("resolve", await tab());
  expect(told.at(-1)).toBe(
    "The branch conflicts with main. Merge main in, resolve the conflicts and push.",
  );
});

test("Ready, Auto-merge and Update branch go as the person, with the head where it matters", async () => {
  world.fake.agent(canvasId).push();
  await api().canvases.pullRequest.open(canvasId);
  const { prActions, acted } = actions();
  await prActions.run("ready", await tab());
  github().setChecks([{ name: "ci / test", state: "running", required: true }]);
  await prActions.run("auto_merge", await tab());
  github().setChecks([{ name: "ci / test", state: "passed" }]);
  await api().canvases.pullRequest.autoMerge(canvasId, false);
  github().protect({ upToDate: true });
  github().baseChanged();
  const behind = await tab();
  await prActions.run("update_branch", behind);
  expect(acted).toEqual([
    { kind: "ready" },
    { kind: "auto_merge", on: true },
    { kind: "update_branch", headSha: behind.pullRequest!.head.sha },
  ]);
  // Never offered on the phone: nothing goes.
  await prActions.run("blocked", await tab());
  await prActions.run("create_pr", await tab());
  expect(acted).toHaveLength(3);
});

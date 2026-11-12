import { expect, test } from "bun:test";
import { createFakeBackend, settle } from "@ponzu/client/testing";
import { chromeAction } from "./pull-request-map.ts";
import { opensWith, PullRequestStore, tabMenu } from "./pull-request-store.ts";
import { storePonzu } from "./store-ponzu.ts";

/*
 * A canvas's pull request on Ponzu Cloud in memory, which keeps the API's next action and
 * refusals: each state and action. How the API's answer maps onto the tab is tested with the
 * mapping, in packages/client/src/model/pull-request-map.test.ts.
 */

async function world() {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const client = backend.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Pricing",
  });
  const said: string[] = [];
  const told: string[] = [];
  const ponzu = storePonzu(client.api);
  const store = new PullRequestStore({
    ponzu,
    canvasId: canvas.id,
    say: (m) => said.push(m),
    tellAgent: (t) => told.push(t),
  });
  const github = backend.canvas(canvas.id).github!;
  const read = async () => {
    store.refresh();
    await settle();
    return store.getSnapshot();
  };
  const run = async (action: Parameters<PullRequestStore["run"]>[0]) => {
    store.run(action);
    await settle();
    return store.getSnapshot();
  };
  return { backend, client, ponzu, canvas, store, github, said, told, read, run };
}

test("from changes on the branch to a merge: create, ready, merge, and the canvas settles", async () => {
  const w = await world();
  expect((await w.read()).tab?.nextAction).toBe("none");

  w.backend.agent(w.canvas.id).push([{ path: "src/pricing.tsx", additions: 40 }]);
  const pushed = await w.read();
  expect(chromeAction(pushed.tab!)).toBe("create_pr");

  w.store.run("create_pr");
  expect(w.store.getSnapshot().busy).toBe("create_pr");
  await settle();
  const opened = w.store.getSnapshot();
  expect(opened.busy).toBeNull();
  expect(opened.tab?.pullRequest).toMatchObject({ state: "draft", title: "Pricing" });
  expect(chromeAction(opened.tab!)).toBe("ready");
  // GitHub's word is said in the thread once, and the head follows.
  const head = await w.client.api.canvases.get(w.canvas.id);
  expect([head.prNumber, head.prState]).toEqual([opened.tab!.pullRequest!.number, "draft"]);

  expect(chromeAction((await w.run("ready")).tab!)).toBe("merge");
  const merged = await w.run("merge");
  expect(merged.tab?.pullRequest?.state).toBe("merged");
  expect(chromeAction(merged.tab!)).toBeNull();
  expect((await w.client.api.canvases.get(w.canvas.id)).status).toBe("settled");
  const notices = w.backend
    .canvas(w.canvas.id)
    .thread.map((e) => e.item)
    .filter((i) => i.kind === "notice");
  expect(
    notices.map((n) => n.kind === "notice" && n.payload.type === "pull_request" && n.payload.state),
  ).toEqual(["draft", "merged"]);
  expect(w.said).toEqual([]);
});

test("a canvas opened again starts from its last answer; a read asked ahead stands for the one on opening", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push([{ path: "src/pricing.tsx", additions: 40 }]);
  await w.read();
  w.store.close();
  // Opened again, on the same cache: the tab is there before anything is read.
  const { ponzu } = w;
  const again = new PullRequestStore({ ponzu, canvasId: w.canvas.id, say() {}, tellAgent() {} });
  expect(again.getSnapshot()).toMatchObject({ status: "ready" });
  expect(chromeAction(again.getSnapshot().tab!)).toBe("create_pr");
  // Another canvas never shows this one's.
  const other = await w.client.api.canvases.create({
    workspaceId: w.canvas.workspaceId,
    repoId: w.canvas.repo!.id,
    name: "Other",
  });
  const elsewhere = new PullRequestStore({ ponzu, canvasId: other.id, say() {}, tellAgent() {} });
  expect(elsewhere.getSnapshot()).toMatchObject({ tab: null, status: "loading" });
  // Just answered (as a read on the row's hover would be): the read on opening stands on it.
  let reads = 0;
  const get = w.client.api.canvases.pullRequest.get;
  w.client.api.canvases.pullRequest.get = (id) => {
    reads++;
    return get(id);
  };
  again.refreshOnOpen();
  expect(reads).toBe(0);
  // Asked a moment ago, it is as good as confirmed.
  expect(again.getSnapshot().confirmed).toBe(true);
  again.close();
  // Kept from longer ago: shown, but not yet confirmed, and the read on opening goes out.
  ponzu.queryClient.setQueryData(ponzu.queries.pullRequest(w.canvas.id).queryKey, (tab) => tab, {
    updatedAt: Date.now() - 60_000,
  });
  const later = new PullRequestStore({ ponzu, canvasId: w.canvas.id, say() {}, tellAgent() {} });
  expect(later.getSnapshot()).toMatchObject({ status: "ready", confirmed: false });
  const kept = later.getSnapshot().tab;
  later.refreshOnOpen();
  await settle();
  expect(reads).toBeGreaterThan(0);
  // The same answer again: the same tab (nothing on screen changes), now confirmed.
  expect(later.getSnapshot()).toMatchObject({ confirmed: true });
  expect(later.getSnapshot().tab).toBe(kept);
  later.close();
  elsewhere.close();
});

test("commits only the sandbox holds: Create PR is offered, waits for the push, then opens", async () => {
  const w = await world();
  // The agent's push failed: its commit is only in the sandbox.
  w.github.commitUnpushed([{ path: "src/onboarding.tsx" }], "Ponzu couldn't push pz/pricing.");
  const before = await w.read();
  expect(before.tab?.branch).toMatchObject({ exists: false, unpushed: 1 });
  expect(chromeAction(before.tab!)).toBe("create_pr");

  w.store.run("create_pr");
  await settle();
  expect(w.github.pushesAsked).toBe(1);
  // Still busy: the pull request opens once GitHub has the commit. What the last push said is moot.
  expect(w.store.getSnapshot().busy).toBe("create_pr");
  expect((await w.read()).busy).toBe("create_pr");

  w.github.landPush();
  await w.read();
  await settle();
  const opened = w.store.getSnapshot();
  expect(opened.busy).toBeNull();
  expect(opened.tab?.pullRequest).toMatchObject({ state: "draft" });
  expect(w.said).toEqual([]);
  w.store.close();
});

test("a push Create PR waits on that fails says why, and the button comes back", async () => {
  const w = await world();
  w.github.commitUnpushed();
  await w.read();
  w.store.run("create_pr");
  await settle();
  expect(w.store.getSnapshot().busy).toBe("create_pr");

  w.github.failPush("pz/pricing on GitHub has commits this canvas doesn't.");
  await w.read();
  expect(w.store.getSnapshot().busy).toBeNull();
  expect(w.said).toEqual(["pz/pricing on GitHub has commits this canvas doesn't."]);
  expect(chromeAction(w.store.getSnapshot().tab!)).toBe("create_pr");
  w.store.close();
});

test("checks running offer auto-merge; failing ones and conflicts are asked of the agent", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");

  w.github.setChecks([{ name: "ci / test", state: "running", required: true }]);
  expect(chromeAction((await w.read()).tab!)).toBe("auto_merge");
  expect(chromeAction((await w.run("auto_merge")).tab!)).toBe("auto_merge_on");
  // Waiting on GitHub: pressing it does nothing.
  await w.run("auto_merge_on");

  w.github.setChecks([{ name: "ci / e2e", state: "failed" }]);
  expect(chromeAction((await w.read()).tab!)).toBe("fix_checks");
  await w.run("fix_checks");
  expect(w.told).toEqual(["Fix the failing checks on the pull request (ci / e2e) and push."]);

  w.github.baseChanged({ conflicts: true });
  expect(chromeAction((await w.read()).tab!)).toBe("resolve");
  await w.run("resolve");
  expect(w.told[1]).toBe(
    "The branch conflicts with main. Merge main in, resolve the conflicts and push.",
  );
});

test("behind its base, Update branch; held by the rules without auto-merge, Merge asks first", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");

  w.github.protect({ upToDate: true });
  w.github.baseChanged();
  expect(chromeAction((await w.read()).tab!)).toBe("update_branch");
  expect(chromeAction((await w.run("update_branch")).tab!)).toBe("merge");

  w.github.autoMergeAllowed = false;
  w.github.protect({ review: true });
  const held = await w.read();
  expect(chromeAction(held.tab!)).toBe("blocked");
  // Nothing merges until the person says so.
  expect((await w.run("blocked")).bypass).toEqual({
    reason: "The repo's rules want an approving review.",
    headSha: held.tab!.pullRequest!.head.sha,
  });
  w.store.cancelBypass();
  expect(w.store.getSnapshot().bypass).toBeNull();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("open");

  await w.run("blocked");
  w.store.confirmBypass();
  await settle();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("merged");
});

test("Merge anyway goes out with the commit the person confirmed, never one pushed since", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.autoMergeAllowed = false;
  w.github.protect({ review: true });
  await w.read();
  const asked = (await w.run("blocked")).bypass!;

  // The agent pushes while the dialog is open, and the next read has the new head.
  w.backend.agent(w.canvas.id).push([{ path: "src/x.ts", additions: 3 }]);
  const moved = await w.read();
  expect(moved.tab?.pullRequest?.head.sha).not.toBe(asked.headSha);
  // The question was about a commit that isn't the head now: it closes.
  expect(moved.bypass).toBeNull();
  w.store.confirmBypass();
  await settle();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("open");

  // Asked again, and confirmed after a push the store hasn't read: the API refuses it.
  const again = (await w.run("blocked")).bypass!;
  w.backend.agent(w.canvas.id).push([{ path: "src/y.ts", additions: 1 }]);
  w.store.confirmBypass();
  await settle();
  expect(w.said.at(-1)).toBe("The branch has new commits since you looked. Look again first.");
  const after = w.store.getSnapshot();
  expect(after.tab?.pullRequest?.state).toBe("open");
  expect(after.tab?.pullRequest?.head.sha).not.toBe(again.headSha);
});

test("the bypass question keeps its reason true, and closes once the rules let the merge go", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.autoMergeAllowed = false;
  w.github.protect({ review: true });
  await w.read();
  expect((await w.run("blocked")).bypass?.reason).toBe(
    "The repo's rules want an approving review.",
  );
  w.github.protect({ review: false });
  expect((await w.read()).bypass).toBeNull();
});

test("Fix checks and Resolve ask the agent once for a commit", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.setChecks([{ name: "ci / e2e", state: "failed" }]);
  await w.read();
  expect((await w.run("fix_checks")).asked).toBe("fix_checks");
  await w.run("fix_checks");
  expect(w.told).toHaveLength(1);

  // Its turn over with nothing pushed, it may be asked again.
  w.store.agentIdle();
  expect(w.store.getSnapshot().asked).toBeNull();
  await w.run("fix_checks");
  expect(w.told).toHaveLength(2);

  // A push moves the head: the question is new.
  w.backend.agent(w.canvas.id).push();
  w.github.setChecks([{ name: "ci / e2e", state: "failed" }]);
  expect((await w.read()).asked).toBeNull();
  await w.run("fix_checks");
  expect(w.told).toHaveLength(3);
});

test("a merge GitHub's rules refuse says why, and the button follows what is true now", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.protect({ review: true });
  // The person looked before the rules changed: the button still says Merge.
  const stale = w.store.getSnapshot();
  expect(chromeAction(stale.tab!)).toBe("merge");
  await w.run("merge");
  expect(w.said).toEqual(["The repo's rules want an approving review first."]);
  expect(chromeAction(w.store.getSnapshot().tab!)).toBe("auto_merge");

  // A push since the person looked.
  w.github.protect({ review: false });
  await w.read();
  w.backend.agent(w.canvas.id).push();
  await w.run("merge");
  expect(w.said[1]).toBe("The branch has new commits since you looked. Look again first.");
});

test("a closed pull request offers to open another once the branch has changes", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.client.api.canvases.pullRequest.close(w.canvas.id);
  const closed = await w.read();
  expect(closed.tab?.pullRequest?.state).toBe("closed");
  expect(chromeAction(closed.tab!)).toBe("create_pr");
});

test("Close asks first, closes the one it asked about, and Create PR comes back", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  const draft = (await w.run("create_pr")).tab!.pullRequest!;
  // A draft can be closed too; nothing is said to GitHub until the person confirms.
  expect(tabMenu(w.store.getSnapshot(), w.store)).toMatchObject({ busy: false });
  expect(tabMenu(w.store.getSnapshot(), w.store)?.onTurnOffAutoMerge).toBeUndefined();
  w.store.askClose();
  expect(w.store.getSnapshot().closing).toEqual({ number: draft.number });
  w.store.cancelClose();
  expect(w.store.getSnapshot().closing).toBeNull();
  expect((await w.read()).tab?.pullRequest?.state).toBe("draft");

  w.store.askClose();
  w.store.confirmClose();
  expect(w.store.getSnapshot()).toMatchObject({ busy: "close", closing: null });
  await settle();
  const closed = w.store.getSnapshot();
  expect(closed.busy).toBeNull();
  expect(closed.tab?.pullRequest?.state).toBe("closed");
  expect(chromeAction(closed.tab!)).toBe("create_pr");
  // Nothing more to do to a closed one.
  expect(tabMenu(closed, w.store)).toBeNull();
  w.store.askClose();
  expect(w.store.getSnapshot().closing).toBeNull();
  expect(w.said).toEqual([]);

  // Create PR opens a new one from the same branch.
  const again = (await w.run("create_pr")).tab!.pullRequest!;
  expect(again.state).toBe("draft");
  expect(again.number).not.toBe(draft.number);
});

test("a Close asked before an auto-merge landed closes nothing, read or not", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.setChecks([{ name: "ci / test", state: "running", required: true }]);
  await w.read();
  await w.run("auto_merge");

  // The read shows it merged while the dialog is open: the question closes, and so does nothing.
  w.store.askClose();
  w.github.setChecks([{ name: "ci / test", state: "passed", required: true }]);
  await w.client.api.canvases.pullRequest.merge(w.canvas.id, {
    headSha: w.store.getSnapshot().tab!.pullRequest!.head.sha,
  });
  expect((await w.read()).closing).toBeNull();
  w.store.confirmClose();
  await settle();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("merged");
  expect(w.said).toEqual([]);
});

test("a Close confirmed after a merge the store hasn't read is refused by the API, and says so", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  const number = w.store.getSnapshot().tab!.pullRequest!.number;
  w.store.askClose();
  await w.client.api.canvases.pullRequest.merge(w.canvas.id, {
    headSha: w.store.getSnapshot().tab!.pullRequest!.head.sha,
  });
  w.store.confirmClose();
  await settle();
  expect(w.said).toEqual([`#${number} is merged.`]);
  // The refusal reads it again: the tab shows it merged.
  expect(w.store.getSnapshot()).toMatchObject({
    busy: null,
    tab: { pullRequest: { state: "merged" } },
  });
});

test("a Close confirmed after a newer pull request opened, unread, leaves the newer one open", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  const first = (await w.run("create_pr")).tab!.pullRequest!;
  w.store.askClose();
  // Someone closes it and a new one opens from the branch before the store reads either.
  await w.client.api.canvases.pullRequest.close(w.canvas.id);
  const second = (await w.client.api.canvases.pullRequest.open(w.canvas.id)).pullRequest!;
  expect(second.number).not.toBe(first.number);

  w.store.confirmClose();
  await settle();
  expect(w.said).toEqual([
    `This canvas's pull request is #${second.number} now, not #${first.number}. Look again first.`,
  ]);
  expect(w.store.getSnapshot()).toMatchObject({
    busy: null,
    tab: { pullRequest: { number: second.number, state: "draft" } },
  });
});

test("Turn off auto-merge, from the menu while it is on; the button offers it again", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.setChecks([{ name: "ci / test", state: "running", required: true }]);
  await w.read();
  expect(tabMenu(w.store.getSnapshot(), w.store)?.onTurnOffAutoMerge).toBeUndefined();
  // Off already: nothing goes to the API.
  w.store.turnOffAutoMerge();
  expect(w.store.getSnapshot().busy).toBeNull();

  expect(chromeAction((await w.run("auto_merge")).tab!)).toBe("auto_merge_on");
  const menu = tabMenu(w.store.getSnapshot(), w.store)!;
  menu.onTurnOffAutoMerge!();
  expect(w.store.getSnapshot().busy).toBe("auto_merge_off");
  // One thing at a time: Close waits while it is on its way.
  expect(tabMenu(w.store.getSnapshot(), w.store)?.busy).toBe(true);
  w.store.askClose();
  expect(w.store.getSnapshot().closing).toBeNull();
  await settle();
  const off = w.store.getSnapshot();
  expect(off.busy).toBeNull();
  expect(off.tab?.pullRequest?.autoMerge).toBeNull();
  expect(chromeAction(off.tab!)).toBe("auto_merge");
  expect((await w.client.api.canvases.get(w.canvas.id)).prState).toBe("open");
  expect(w.said).toEqual([]);
});

test("the description it opens with: the agent's kept words while Create PR is offered", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push();
  w.github.describe(
    "<!-- ponzu:summary -->\nShortens **pricing** to one table.\n<!-- /ponzu:summary -->",
  );
  const before = (await w.read()).tab!;
  expect(before.pullRequest).toBeNull();
  expect(opensWith(before)).toBe("Shortens **pricing** to one table.");

  // Open, its description says them: the tab doesn't say them twice.
  const opened = (await w.run("create_pr")).tab!;
  expect(opened.summary).toBeNull();
  expect(opensWith(opened)).toBeNull();

  // Closed with the branch still ahead: what Create PR opens the next one with.
  await w.client.api.canvases.pullRequest.close(w.canvas.id);
  const closed = (await w.read()).tab!;
  expect(chromeAction(closed)).toBe("create_pr");
  expect(opensWith(closed)).toBe("Shortens **pricing** to one table.");

  // Merged with nothing since: nothing to open, so nothing it opens with.
  await w.run("create_pr");
  await w.run("ready");
  const merged = (await w.run("merge")).tab!;
  expect(merged.summary).not.toBeNull();
  expect(opensWith(merged)).toBeNull();
  // An API older than the field.
  expect(opensWith({ ...closed, summary: undefined as unknown as null })).toBeNull();
});

test("a file's diff is asked for when its card opens, with where a renamed one was", async () => {
  const w = await world();
  w.backend.agent(w.canvas.id).push([
    { path: "src/a.tsx", patch: "@@ -1 +1 @@\n-a\n+b" },
    { path: "logo.png", patch: null },
    { path: "src/hero-copy.tsx", change: "renamed", previousPath: "src/copy.tsx" },
  ]);
  await w.read();
  await w.run("create_pr");
  expect(await w.store.loadDiff("src/a.tsx")).toEqual({
    diff: { kind: "text", patch: "@@ -1 +1 @@\n-a\n+b" },
    previousPath: null,
  });
  expect(await w.store.loadDiff("logo.png")).toEqual({
    diff: { kind: "binary" },
    previousPath: null,
  });
  expect((await w.store.loadDiff("src/hero-copy.tsx")).previousPath).toBe("src/copy.tsx");
  await expect(w.store.loadDiff("nope.ts")).rejects.toMatchObject({ code: "not_found" });
});

test("a Scratch canvas has no pull request to read", async () => {
  const w = await world();
  const scratch = await w.client.api.canvases.create({
    workspaceId: (await w.client.api.canvases.get(w.canvas.id)).workspaceId,
  });
  const refused = await w.client.api.canvases.pullRequest.get(scratch.id).catch((e) => e);
  expect(refused.code).toBe("no_repository");
});

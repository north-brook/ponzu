import { expect, test } from "bun:test";
import type { PullRequestSummary } from "./model.ts";
import { actionBlock, checksGlyph, nextAction, pullRequestIcon } from "./pull-request.ts";

const pr = (over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 412,
  state: "open",
  checks: "passing",
  mergeable: true,
  autoMerge: false,
  ...over,
});

test("each state offers its one next action, as the PR states board lists them", () => {
  expect(nextAction(null, false)).toBeNull();
  expect(nextAction(null, true)).toBe("create_pr");
  expect(nextAction(pr({ state: "draft", checks: "failing" }), true)).toBe("ready");
  expect(nextAction(pr({ checks: "running" }), true)).toBe("auto_merge");
  expect(nextAction(pr({ checks: "running", autoMerge: true }), true)).toBe("auto_merge_on");
  expect(nextAction(pr({ checks: "failing" }), true)).toBe("fix_checks");
  expect(nextAction(pr({ mergeable: false, checks: "failing" }), true)).toBe("resolve");
  expect(nextAction(pr(), true)).toBe("merge");
  expect(nextAction(pr({ state: "merged" }), true)).toBeNull();
  expect(nextAction(pr({ state: "closed" }), true)).toBe("create_pr");
});

test("an action is blocked without write access, and the agent's wait on its Claude", () => {
  const bryce = { id: "usr_bryce", name: "Bryce Bjork", login: "brycedbjork", avatarUrl: null };
  const repo = { id: "repo_fernwood", owner: "north-brook", name: "fernwood" };
  const readOnly = { kind: "read_only", repo } as const;
  const limit = { kind: "claude_limit", owner: bryce, until: "2026-11-10T21:00:00Z" } as const;
  expect(actionBlock("merge", null, "usr_maya")).toBeNull();
  expect(actionBlock("merge", readOnly, "usr_maya")).toBe(
    "Needs write access to north-brook/fernwood",
  );
  // Merging is GitHub's: the owner's Claude being at its limit doesn't stop it.
  expect(actionBlock("merge", limit, "usr_maya")).toBeNull();
  expect(actionBlock("fix_checks", limit, "usr_maya")).toMatch(
    /^Bryce's plan is at its limit until \d+:\d\d [AP]M\. This design waits\.$/,
  );
  expect(actionBlock("create_pr", { kind: "claude_disconnected", owner: bryce }, bryce.id)).toBe(
    "Your Claude isn't connected. This design waits.",
  );
});

test("the mark's icon and checks follow the state", () => {
  expect(pullRequestIcon(pr())).toBe("open");
  expect(pullRequestIcon(pr({ mergeable: false }))).toBe("conflict");
  expect(pullRequestIcon(pr({ state: "merged" }))).toBe("merged");
  expect(checksGlyph(pr({ state: "draft", checks: "passing" }))).toBe("draft");
  expect(checksGlyph(pr({ checks: "running" }))).toBe("running");
  expect(checksGlyph(pr({ checks: "none" }))).toBeNull();
  expect(checksGlyph(pr({ state: "merged" }))).toBeNull();
});

import { expect, test } from "bun:test";
import type { PullRequestSummary } from "./model.ts";
import { checksGlyph, nextAction, pullRequestIcon } from "./pull-request.ts";

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

test("the mark's icon and checks follow the state", () => {
  expect(pullRequestIcon(pr())).toBe("open");
  expect(pullRequestIcon(pr({ mergeable: false }))).toBe("conflict");
  expect(pullRequestIcon(pr({ state: "merged" }))).toBe("merged");
  expect(checksGlyph(pr({ state: "draft", checks: "passing" }))).toBe("draft");
  expect(checksGlyph(pr({ checks: "running" }))).toBe("running");
  expect(checksGlyph(pr({ checks: "none" }))).toBeNull();
  expect(checksGlyph(pr({ state: "merged" }))).toBeNull();
});

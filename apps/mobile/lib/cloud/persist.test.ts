import { expect, test } from "bun:test";
import { queryKeys } from "@ponzu/client/query";
import { buster, persistable, phoneKeys } from "./persist";

test("what opens the app offline goes to disk", () => {
  for (const key of [
    queryKeys.me(),
    queryKeys.workspace("ws_1"),
    phoneKeys.canvases("ws_1"),
    phoneKeys.canvasView("cnv_1"),
    queryKeys.pullRequest("cnv_1"),
    queryKeys.claudeDefaults(),
    queryKeys.usage("ws_1"),
    queryKeys.notifications(),
  ]) {
    expect(persistable(key)).toBe(true);
  }
});

test("thread pages, questions and everything not named stay in memory", () => {
  for (const key of [
    queryKeys.threadPage("cnv_1", null, 50),
    queryKeys.question("cnv_1", "q_1"),
    queryKeys.pullRequestFile("cnv_1", "a.ts", "abc"),
    queryKeys.canvasPeople("cnv_1"),
    queryKeys.githubAccounts(),
    queryKeys.claudeAccount(),
    queryKeys.environments("ws_1"),
    queryKeys.workspaces(),
    queryKeys.canvas("cnv_1"),
    ["other", "me"],
    [],
  ]) {
    expect(persistable(key)).toBe(false);
  }
});

test("no key the cache may write to disk holds a token", () => {
  // The keys are ids and names; what a secret looks like never appears in one.
  const keys = [queryKeys.me(), phoneKeys.canvases("ws_1"), phoneKeys.canvasView("cnv_1")];
  for (const key of keys) expect(JSON.stringify(key)).not.toMatch(/token|secret|eyJ|sk-/i);
});

test("a new version or another person starts from nothing", () => {
  expect(buster("1.0.0", "usr_1")).toBe("1.0.0:usr_1");
  expect(buster("1.0.0", "usr_1")).not.toBe(buster("1.0.0", "usr_2"));
  expect(buster("1.0.0", "usr_1")).not.toBe(buster("1.0.1", "usr_1"));
});

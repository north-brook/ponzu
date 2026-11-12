import { expect, test } from "bun:test";
import { linksIn, parseDeepLink } from "./deep-links.ts";

test("a canvas, with the page and artboard to open it on", () => {
  expect(parseDeepLink("ponzu://canvas/cnv_0000000000000001", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "cnv_0000000000000001",
  });
  expect(parseDeepLink("ponzu://canvas/cnv_1?page=pg_2&artboard=ab_3", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    pageId: "pg_2",
    artboardId: "ab_3",
  });
  // A page or board id that couldn't be one is left out, not trusted.
  expect(parseDeepLink("ponzu://canvas/cnv_1?page=%3Cscript%3E", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
  });
});

test("a link from before canvases had their name opens the same canvas", () => {
  expect(parseDeepLink("ponzu://design/des_7k2m9x4q0c8v5n1t", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "des_7k2m9x4q0c8v5n1t",
  });
  expect(parseDeepLink("ponzu-dev://design/cnv_1?page=pg_2&artboard=ab_3", "ponzu-dev")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    pageId: "pg_2",
    artboardId: "ab_3",
  });
});

test("the way back from GitHub's install page, as the API's setup page links it", () => {
  expect(parseDeepLink("ponzu://github/setup?result=installed&workspace=ws_1", "ponzu")).toEqual({
    kind: "github_setup",
    result: "installed",
    workspaceId: "ws_1",
  });
  for (const result of ["requested", "pending", "sign_in", "failed"]) {
    expect(parseDeepLink(`ponzu://github/setup?result=${result}&workspace=ws_1`, "ponzu")).toEqual({
      kind: "github_setup",
      result: result as "requested",
    });
  }
  expect(parseDeepLink("ponzu://github/setup?result=hacked", "ponzu")).toBeNull();
});

test("what to open once the canvas shows, and the notification it came from", () => {
  expect(parseDeepLink("ponzu://canvas/cnv_1?open=thread&question=q_1&n=ntf_1", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    open: "thread",
    questionId: "q_1",
    notificationId: "ntf_1",
  });
  expect(parseDeepLink("ponzu://canvas/cnv_1?open=pull-request&n=ntf_2", "ponzu")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    open: "pull-request",
    notificationId: "ntf_2",
  });
  expect(
    parseDeepLink(
      "ponzu://canvas/cnv_1?page=pg_1&artboard=ab_1&open=comment&comment=ct_1&n=ntf_3",
      "ponzu",
    ),
  ).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    pageId: "pg_1",
    artboardId: "ab_1",
    open: "comment",
    commentThreadId: "ct_1",
    notificationId: "ntf_3",
  });
  expect(parseDeepLink("ponzu-dev://canvas/cnv_1?open=usage&message=12", "ponzu-dev")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    open: "usage",
    messageSeq: 12,
  });
  // One that isn't one is left out, and the canvas still opens.
  expect(
    parseDeepLink("ponzu://canvas/cnv_1?open=terminal&comment=%2F..&n=%3Cb%3E", "ponzu"),
  ).toEqual({ kind: "canvas", canvasId: "cnv_1" });
});

test("the way back from adding a card, and Settings", () => {
  expect(parseDeepLink("ponzu://billing/card?setup=ast_1&result=added", "ponzu")).toEqual({
    kind: "card_setup",
    setupId: "ast_1",
    result: "added",
  });
  expect(
    parseDeepLink("ponzu-dev://billing/card?setup=ast_1&result=cancelled", "ponzu-dev"),
  ).toEqual({ kind: "card_setup", setupId: "ast_1", result: "cancelled" });
  expect(parseDeepLink("ponzu://billing/card?setup=ast_1&result=expired", "ponzu")).toBeNull();
  expect(parseDeepLink("ponzu://billing/card?result=added", "ponzu")).toBeNull();
  expect(parseDeepLink("ponzu-dev://billing/card?setup=ast_1&result=added", "ponzu")).toBeNull();
  expect(parseDeepLink("ponzu://settings?section=usage", "ponzu")).toEqual({
    kind: "settings",
    section: "usage",
  });
});

test("ids at the edge, and paths that climb", () => {
  const id64 = "a".repeat(64);
  expect(parseDeepLink(`ponzu://canvas/${id64}`, "ponzu")).toEqual({
    kind: "canvas",
    canvasId: id64,
  });
  for (const url of [
    `ponzu://canvas/${id64}a`,
    "ponzu://canvas/../cnv_1",
    "ponzu://canvas/..%2Fcnv_1",
    "ponzu://canvas/cnv_1%2f..",
    "ponzu://canvas/%2E%2E",
    "ponzu://canvas//cnv_1",
  ]) {
    expect(parseDeepLink(url, "ponzu")).toBeNull();
  }
});

test("anything else is dropped", () => {
  for (const url of [
    "ponzu://canvas",
    "ponzu://canvas/cnv_1/extra",
    "ponzu://canvas/cnv%201",
    "ponzu://canvas/cnv_1%2F..",
    "ponzu://design",
    "ponzu://design/des_1/extra",
    "ponzu://design/des%201",
    "ponzu://auth/callback?code=x&state=y",
    "ponzu://open?file=/Users/me/a.design",
    "https://ponzu.design/canvas/cnv_1",
    "not a url",
  ]) {
    expect(parseDeepLink(url, "ponzu")).toBeNull();
  }
});

test("Ponzu Dev answers ponzu-dev:// and leaves Ponzu's (1.x's, on a Mac that has it) alone", () => {
  expect(parseDeepLink("ponzu-dev://canvas/cnv_1?page=pg_2", "ponzu-dev")).toEqual({
    kind: "canvas",
    canvasId: "cnv_1",
    pageId: "pg_2",
  });
  expect(
    parseDeepLink("ponzu-dev://github/setup?result=installed&workspace=ws_1", "ponzu-dev"),
  ).toEqual({ kind: "github_setup", result: "installed", workspaceId: "ws_1" });
  expect(parseDeepLink("ponzu://canvas/cnv_1", "ponzu-dev")).toBeNull();
  expect(parseDeepLink("ponzu-dev://canvas/cnv_1", "ponzu")).toBeNull();
  // Nor its earlier name's.
  expect(parseDeepLink("ponzu-preview://canvas/cnv_1", "ponzu-dev")).toBeNull();
  expect(linksIn(["ponzu-dev", "ponzu://canvas/cnv_1"], "ponzu-dev")).toEqual([]);
});

test("a launch's links, past the executable and its switches", () => {
  expect(
    linksIn(["/opt/Ponzu/ponzu", "--no-sandbox", "ponzu://canvas/cnv_1", "/tmp/a"], "ponzu"),
  ).toEqual(["ponzu://canvas/cnv_1"]);
  expect(linksIn(["ponzu://canvas/cnv_1"], "ponzu")).toEqual([]);
});

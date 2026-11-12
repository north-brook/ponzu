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

test("anything else is dropped", () => {
  for (const url of [
    "ponzu://canvas",
    "ponzu://canvas/cnv_1/extra",
    "ponzu://canvas/dsn%201",
    "ponzu://canvas/cnv_1%2F..",
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

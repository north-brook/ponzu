import { expect, test } from "bun:test";
import { linksIn, parseDeepLink } from "./deep-links.ts";

test("a design, with the page and artboard to open it on", () => {
  expect(parseDeepLink("ponzu://design/dsn_0000000000000001", "ponzu")).toEqual({
    kind: "design",
    designId: "dsn_0000000000000001",
  });
  expect(parseDeepLink("ponzu://design/dsn_1?page=pg_2&artboard=ab_3", "ponzu")).toEqual({
    kind: "design",
    designId: "dsn_1",
    pageId: "pg_2",
    artboardId: "ab_3",
  });
  // A page or board id that couldn't be one is left out, not trusted.
  expect(parseDeepLink("ponzu://design/dsn_1?page=%3Cscript%3E", "ponzu")).toEqual({
    kind: "design",
    designId: "dsn_1",
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
    "ponzu://design",
    "ponzu://design/dsn_1/extra",
    "ponzu://design/dsn%201",
    "ponzu://design/dsn_1%2F..",
    "ponzu://auth/callback?code=x&state=y",
    "ponzu://open?file=/Users/me/a.design",
    "https://ponzu.design/design/dsn_1",
    "not a url",
  ]) {
    expect(parseDeepLink(url, "ponzu")).toBeNull();
  }
});

test("a development build answers its own scheme and not an installed app's", () => {
  expect(parseDeepLink("ponzu-dev://design/dsn_1", "ponzu-dev")).toEqual({
    kind: "design",
    designId: "dsn_1",
  });
  expect(parseDeepLink("ponzu://design/dsn_1", "ponzu-dev")).toBeNull();
  expect(parseDeepLink("ponzu-dev://design/dsn_1", "ponzu")).toBeNull();
});

test("a launch's links, past the executable and its switches", () => {
  expect(
    linksIn(["/opt/Ponzu/ponzu", "--no-sandbox", "ponzu://design/dsn_1", "/tmp/a"], "ponzu"),
  ).toEqual(["ponzu://design/dsn_1"]);
  expect(linksIn(["ponzu://design/dsn_1"], "ponzu")).toEqual([]);
});

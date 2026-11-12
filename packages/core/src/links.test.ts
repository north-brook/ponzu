import { describe, expect, test } from "bun:test";
import { type AppLink, appLink, LINK_SCHEMES, parseAppLink } from "./links.ts";

/** Each kind, written exactly as appLink writes it. */
const EXACT: [AppLink, string][] = [
  [{ kind: "canvas", canvasId: "cnv_1" }, "ponzu://canvas/cnv_1"],
  [
    { kind: "canvas", canvasId: "cnv_1", pageId: "pg_2", artboardId: "ab_3" },
    "ponzu://canvas/cnv_1?page=pg_2&artboard=ab_3",
  ],
  [
    {
      kind: "canvas",
      canvasId: "cnv_1",
      pageId: "pg_2",
      artboardId: "ab_3",
      open: "comment",
      questionId: "q_4",
      commentThreadId: "ct_5",
      messageSeq: 42,
      notificationId: "ntf_6",
    },
    "ponzu://canvas/cnv_1?page=pg_2&artboard=ab_3&open=comment&question=q_4&comment=ct_5&message=42&n=ntf_6",
  ],
  [
    {
      kind: "canvas",
      canvasId: "cnv_1",
      open: "thread",
      questionId: "q_1",
      notificationId: "ntf_1",
    },
    "ponzu://canvas/cnv_1?open=thread&question=q_1&n=ntf_1",
  ],
  [
    { kind: "canvas", canvasId: "cnv_1", open: "pull-request" },
    "ponzu://canvas/cnv_1?open=pull-request",
  ],
  [{ kind: "canvas", canvasId: "cnv_1", open: "usage" }, "ponzu://canvas/cnv_1?open=usage"],
  [{ kind: "canvas", canvasId: "cnv_1", messageSeq: 0 }, "ponzu://canvas/cnv_1?message=0"],
  [
    { kind: "github_setup", result: "installed", workspaceId: "ws_1" },
    "ponzu://github/setup?result=installed&workspace=ws_1",
  ],
  [{ kind: "github_setup", result: "installed" }, "ponzu://github/setup?result=installed"],
  [{ kind: "github_setup", result: "requested" }, "ponzu://github/setup?result=requested"],
  [{ kind: "github_setup", result: "pending" }, "ponzu://github/setup?result=pending"],
  [{ kind: "github_setup", result: "sign_in" }, "ponzu://github/setup?result=sign_in"],
  [{ kind: "github_setup", result: "failed" }, "ponzu://github/setup?result=failed"],
  [
    { kind: "auth_callback", code: "01HZY.abc-_~", state: "s7Qx" },
    "ponzu://auth/callback?code=01HZY.abc-_%7E&state=s7Qx",
  ],
  [
    { kind: "card_setup", setupId: "ast_1", result: "added" },
    "ponzu://billing/card?setup=ast_1&result=added",
  ],
  [
    { kind: "card_setup", setupId: "ast_1", result: "cancelled" },
    "ponzu://billing/card?setup=ast_1&result=cancelled",
  ],
  [{ kind: "settings" }, "ponzu://settings"],
  [{ kind: "settings", section: "usage" }, "ponzu://settings?section=usage"],
  [{ kind: "settings", section: "notifications" }, "ponzu://settings?section=notifications"],
  [{ kind: "settings", section: "account" }, "ponzu://settings?section=account"],
  // A billing ping opens Plan and usage, and names itself so opening it reads it.
  [
    { kind: "settings", section: "usage", notificationId: "ntf_1" },
    "ponzu://settings?section=usage&n=ntf_1",
  ],
  // And names its workspace, so the app opens that one's plan.
  [
    { kind: "settings", section: "usage", workspaceId: "ws_1", notificationId: "ntf_1" },
    "ponzu://settings?section=usage&workspace=ws_1&n=ntf_1",
  ],
];

describe("every kind, both ways", () => {
  test.each(EXACT)("%o is %s", (link, url) => {
    expect(appLink(link, "ponzu")).toBe(url);
    expect(parseAppLink(url, "ponzu")).toEqual(link);
  });

  test("the same in Ponzu Dev's scheme", () => {
    for (const [link, url] of EXACT) {
      const dev = url.replace(/^ponzu:/, "ponzu-dev:");
      expect(appLink(link, "ponzu-dev")).toBe(dev);
      expect(parseAppLink(dev, "ponzu-dev")).toEqual(link);
    }
  });

  test("only the apps' two schemes", () => {
    expect(LINK_SCHEMES).toEqual(["ponzu", "ponzu-dev"]);
  });
});

describe("what a link may also be", () => {
  test("a canvas's link from before the rename is the same canvas, for good", () => {
    expect(parseAppLink("ponzu://design/des_7k2m9x4q0c8v5n1t", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "des_7k2m9x4q0c8v5n1t",
    });
    expect(parseAppLink("ponzu-dev://design/cnv_1?page=pg_2&open=thread", "ponzu-dev")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      pageId: "pg_2",
      open: "thread",
    });
  });

  test("a trailing slash, the scheme in capitals, and query parts in any order", () => {
    expect(parseAppLink("ponzu://canvas/cnv_1/", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(parseAppLink("PONZU://canvas/cnv_1", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(parseAppLink("ponzu://billing/card?result=added&setup=ast_1", "ponzu")).toEqual({
      kind: "card_setup",
      setupId: "ast_1",
      result: "added",
    });
  });

  test("an optional part that isn't one is left out, not trusted", () => {
    expect(
      parseAppLink(
        "ponzu://canvas/cnv_1?page=%3Cscript%3E&artboard=a%2Fb&open=everything&message=-1&n=..&comment=",
        "ponzu",
      ),
    ).toEqual({ kind: "canvas", canvasId: "cnv_1" });
    // Two of one is ambiguous, so neither.
    expect(parseAppLink("ponzu://canvas/cnv_1?page=pg_1&page=pg_2", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(parseAppLink("ponzu://canvas/cnv_1?message=1.5", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(parseAppLink("ponzu://canvas/cnv_1?message=99999999999999999", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(parseAppLink("ponzu://settings?section=billing", "ponzu")).toEqual({
      kind: "settings",
    });
    // A workspace only rides with an install.
    expect(parseAppLink("ponzu://github/setup?result=failed&workspace=ws_1", "ponzu")).toEqual({
      kind: "github_setup",
      result: "failed",
    });
  });

  test("an id of 64 characters is one; 65 is not", () => {
    const id64 = "a".repeat(64);
    expect(parseAppLink(`ponzu://canvas/${id64}`, "ponzu")).toEqual({
      kind: "canvas",
      canvasId: id64,
    });
    expect(parseAppLink(`ponzu://canvas/${id64}a`, "ponzu")).toBeNull();
    expect(parseAppLink(`ponzu://canvas/cnv_1?page=${id64}a`, "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
  });
});

describe("what is dropped", () => {
  test("anything not exactly one of ours", () => {
    for (const url of [
      "ponzu://canvas",
      "ponzu://canvas/",
      "ponzu://canvas/cnv_1/extra",
      "ponzu://canvas/cnv%201",
      "ponzu://canvas/cnv_1%2F..",
      "ponzu://canvas/cnv_1%2f..",
      "ponzu://canvas/..%2Fcnv_1",
      "ponzu://canvas/../cnv_1",
      "ponzu://canvas/./cnv_1",
      "ponzu://canvas//cnv_1",
      "ponzu://canvas/cnv.1",
      "ponzu://canvas/cnv_1#page=pg_2",
      "ponzu://canvas/cnv_1 ",
      "ponzu://canvas\\cnv_1",
      "ponzu://user@canvas/cnv_1",
      "ponzu://canvas:80/cnv_1",
      "ponzu:canvas/cnv_1",
      "ponzu:///canvas/cnv_1",
      "ponzu://design",
      "ponzu://design/des_1/extra",
      "ponzu://design/des%201",
      "ponzu://canvases/cnv_1",
      "ponzu://github/setup",
      "ponzu://github/setup?result=hacked",
      "ponzu://github/setup/extra?result=installed",
      "ponzu://github?result=installed",
      "ponzu://auth/callback",
      "ponzu://auth/callback?code=x",
      "ponzu://auth/callback?state=y",
      "ponzu://auth/callback?code=x&code=z&state=y",
      "ponzu://auth/callback?code=a%20b&state=y",
      `ponzu://auth/callback?code=${"x".repeat(513)}&state=y`,
      "ponzu://billing/card",
      "ponzu://billing/card?setup=ast_1",
      "ponzu://billing/card?setup=ast_1&result=expired",
      "ponzu://billing/card?setup=..&result=added",
      "ponzu://billing?setup=ast_1&result=added",
      "ponzu://settings/usage",
      "ponzu://open?file=/Users/me/a.design",
      "ponzu://",
      "https://ponzu.design/canvas/cnv_1",
      "javascript:alert(1)",
      "",
      "not a url",
    ]) {
      expect(parseAppLink(url, "ponzu")).toBeNull();
    }
  });

  test("another app's scheme, or one the apps don't answer", () => {
    expect(parseAppLink("ponzu-dev://canvas/x", "ponzu")).toBeNull();
    expect(parseAppLink("ponzu://canvas/x", "ponzu-dev")).toBeNull();
    expect(parseAppLink("ponzu-preview://canvas/x", "ponzu-dev")).toBeNull();
    expect(parseAppLink("ponzu-preview://canvas/x", "ponzu-preview")).toBeNull();
    expect(parseAppLink("ponzux://canvas/x", "ponzu")).toBeNull();
    expect(parseAppLink("https://canvas/x", "https")).toBeNull();
  });
});

describe("appLink writes only what parses back", () => {
  test.each<[string, AppLink]>([
    ["a canvas id with a slash", { kind: "canvas", canvasId: "cnv/1" }],
    ["a canvas id of 65", { kind: "canvas", canvasId: "a".repeat(65) }],
    ["an empty page id", { kind: "canvas", canvasId: "cnv_1", pageId: "" }],
    ["a fractional message", { kind: "canvas", canvasId: "cnv_1", messageSeq: 1.5 }],
    ["a negative message", { kind: "canvas", canvasId: "cnv_1", messageSeq: -1 }],
    ["an open it doesn't know", { kind: "canvas", canvasId: "cnv_1", open: "x" as "thread" }],
    [
      "a workspace on a failed install",
      { kind: "github_setup", result: "failed", workspaceId: "ws_1" },
    ],
    ["a code with a space", { kind: "auth_callback", code: "a b", state: "s" }],
    ["an empty state", { kind: "auth_callback", code: "c", state: "" }],
    ["a setup id with a dot", { kind: "card_setup", setupId: "a.b", result: "added" }],
  ])("%s throws", (_, link) => {
    expect(() => appLink(link, "ponzu")).toThrow();
  });

  test("in a scheme the apps don't answer, it throws", () => {
    expect(() => appLink({ kind: "settings" }, "ponzu-preview" as "ponzu")).toThrow();
  });
});

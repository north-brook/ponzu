import { describe, expect, test } from "bun:test";
import { parseAppLink } from "@ponzu/core/links";
import { incomingPath, parseLink, pathOf, threadLink } from "./links";

describe("the link grammar, as the phone reads it (@ponzu/core/links)", () => {
  test("a canvas link, with everything it can carry", () => {
    expect(
      parseAppLink(
        "ponzu-dev://canvas/cnv_123?page=pg_1&artboard=ab_2&open=thread&question=q_3&comment=th_4&message=12&n=ntf_5",
        "ponzu-dev",
      ),
    ).toEqual({
      kind: "canvas",
      canvasId: "cnv_123",
      pageId: "pg_1",
      artboardId: "ab_2",
      open: "thread",
      questionId: "q_3",
      commentThreadId: "th_4",
      messageSeq: 12,
      notificationId: "ntf_5",
    });
  });

  test("design/<id>, from before canvases had their name, is the same canvas link for good", () => {
    expect(parseAppLink("ponzu://design/cnv_abc?page=pg_1", "ponzu")).toEqual({
      kind: "canvas",
      canvasId: "cnv_abc",
      pageId: "pg_1",
    });
  });

  test("the other links", () => {
    expect(parseAppLink("ponzu://github/setup?result=installed&workspace=ws_1", "ponzu")).toEqual({
      kind: "github_setup",
      result: "installed",
      workspaceId: "ws_1",
    });
    expect(parseAppLink("ponzu://github/setup?result=pending&workspace=ws_1", "ponzu")).toEqual({
      kind: "github_setup",
      result: "pending",
    });
    expect(parseAppLink("ponzu://auth/callback?code=c&state=s", "ponzu")).toEqual({
      kind: "auth_callback",
      code: "c",
      state: "s",
    });
    expect(parseAppLink("ponzu://billing/card?setup=st_1&result=added", "ponzu")).toEqual({
      kind: "card_setup",
      setupId: "st_1",
      result: "added",
    });
    expect(parseAppLink("ponzu://settings?section=usage", "ponzu")).toEqual({
      kind: "settings",
      section: "usage",
    });
    expect(parseAppLink("ponzu://settings?section=billing", "ponzu")).toEqual({
      kind: "settings",
    });
  });

  test("malformed ids, unknown values and unknown paths are dropped", () => {
    for (const url of [
      "ponzu://canvas/",
      "ponzu://canvas/has space",
      `ponzu://canvas/${"x".repeat(65)}`,
      "ponzu://canvas/cnv_1/extra",
      "ponzu://github/setup?result=hacked",
      "ponzu://github/setup",
      "ponzu://auth/callback?code=c",
      "ponzu://open?mac=studio&file=/x.design",
      "ponzu://",
      "ponzu://%E0%A4%A",
    ]) {
      expect(parseAppLink(url, "ponzu")).toBeNull();
    }
    const link = parseAppLink(
      "ponzu://canvas/cnv_1?page=bad%20id&open=delete&message=-3&artboard=ab_1",
      "ponzu",
    );
    expect(link).toEqual({ kind: "canvas", canvasId: "cnv_1", artboardId: "ab_1" });
  });
});

describe("links in this app", () => {
  test("a ponzu:// link on Ponzu Dev is refused, and the other way round", () => {
    expect(parseLink("ponzu://canvas/cnv_1", "ponzu-dev")).toBeNull();
    expect(parseLink("ponzu-dev://canvas/cnv_1", "ponzu")).toBeNull();
    expect(parseLink("https://evil.example/canvas/cnv_1", "ponzu")).toBeNull();
    expect(incomingPath("ponzu://canvas/cnv_1", "ponzu-dev")).toBe("/");
  });

  test("a canvas link opens the canvas, its sheet from `open` or a question", () => {
    const route = parseLink("ponzu-dev://canvas/cnv_1?open=pull-request&page=pg_1", "ponzu-dev");
    expect(route).toEqual({
      screen: "canvas",
      id: "cnv_1",
      params: { page: "pg_1", sheet: "pull-request" },
    });
    expect(pathOf(route!)).toBe("/canvas/cnv_1?page=pg_1&sheet=pull-request");
    expect(incomingPath("ponzu-dev://canvas/cnv_1?question=q_1&message=4", "ponzu-dev")).toBe(
      "/canvas/cnv_1?question=q_1&sheet=chat&message=4",
    );
    expect(incomingPath("ponzu-dev://design/cnv_1", "ponzu-dev")).toBe("/canvas/cnv_1");
  });

  test("the other routes", () => {
    expect(incomingPath("ponzu://github/setup?result=installed&workspace=ws_1", "ponzu")).toBe(
      "/github/setup?result=installed&workspace=ws_1",
    );
    expect(incomingPath("ponzu://auth/callback?code=c&state=s", "ponzu")).toBe("/auth/callback");
    expect(incomingPath("ponzu://settings?section=account", "ponzu")).toBe(
      "/settings?section=account",
    );
    // The phone never adds a card.
    expect(incomingPath("ponzu://billing/card?setup=st_1&result=added", "ponzu")).toBe("/");
  });

  test("a universal link to a canvas on ponzu.design is the canvas link", () => {
    expect(incomingPath("https://ponzu.design/canvases/cnv_9?page=pg_2", "ponzu")).toBe(
      "/canvas/cnv_9?page=pg_2",
    );
    expect(incomingPath("https://ponzu.design/pricing", "ponzu")).toBe("/");
  });

  test("dev links reach app/dev.tsx only on the fake backend", () => {
    expect(incomingPath("ponzu-dev://dev?seed=signed-in", "ponzu-dev", { dev: true })).toBe(
      "/dev?seed=signed-in",
    );
    expect(incomingPath("ponzu-dev://dev?seed=signed-in", "ponzu-dev")).toBe("/");
    expect(incomingPath("ponzu://dev?seed=signed-in", "ponzu-dev", { dev: true })).toBe("/");
  });

  test("a path already in the app passes as it is", () => {
    expect(incomingPath("/canvases", "ponzu")).toBe("/canvases");
  });
});

describe("a link in Ponzu's reply (threadLink)", () => {
  test("the canvas's own address, a board or a page of it", () => {
    expect(threadLink("https://ponzu.design/canvases/cnv_1?artboard=ab_2", "ponzu")).toEqual({
      screen: "canvas",
      id: "cnv_1",
      params: { artboard: "ab_2" },
    });
    expect(threadLink("https://ponzu.design/canvases/cnv_1?page=pg_1", "ponzu")).toEqual({
      screen: "canvas",
      id: "cnv_1",
      params: { page: "pg_1" },
    });
    expect(threadLink("https://ponzu.design/designs/des_1/", "ponzu")).toEqual({
      screen: "canvas",
      id: "des_1",
      params: {},
    });
  });

  test("this build's own canvas link", () => {
    expect(threadLink("ponzu-dev://canvas/cnv_1?artboard=ab_2", "ponzu-dev")).toMatchObject({
      id: "cnv_1",
      params: { artboard: "ab_2" },
    });
    expect(threadLink("ponzu://canvas/cnv_1", "ponzu-dev")).toBeNull();
  });

  test.each([
    "https://ponzu.design.evil.test/canvases/cnv_1",
    "https://evil.test/canvases/cnv_1",
    "http://ponzu.design/canvases/cnv_1",
    "https://ponzu.design:8443/canvases/cnv_1",
    "https://user@ponzu.design/canvases/cnv_1",
    "https://ponzu.design/canvases/cnv_1/../settings",
    "https://ponzu.design/canvases/cnv_1?artboard=ab_1&artboard=ab_2",
    "https://ponzu.design/canvases/cnv_1?artboard=..%2Fx",
    "https://ponzu.design/pricing",
    "javascript:alert(1)",
  ])("%s is not a canvas link", (href) => {
    expect(threadLink(href, "ponzu-dev")).toBeNull();
  });
});

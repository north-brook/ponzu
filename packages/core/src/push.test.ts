import { describe, expect, test } from "bun:test";
import { appLink, parseAppLink } from "./links.ts";
import { linkOfPush, linkOfPushData, type PushData, parsePushData } from "./push.ts";

const question: PushData = {
  v: 1,
  n: "ntf_1",
  k: "needs_you",
  c: "cnv_1",
  w: "ws_1",
  o: "thread",
  q: "q_1",
};

describe("a ping's data", () => {
  test("version 1, ids only, is taken as it is", () => {
    expect(parsePushData(question)).toEqual(question);
    const pin: PushData = {
      v: 1,
      n: "ntf_2",
      k: "teammate_comment",
      c: "cnv_1",
      o: "comment",
      p: "pg_1",
      a: "ab_1",
      t: "ct_1",
    };
    expect(parsePushData(pin)).toEqual(pin);
    expect(
      parsePushData({ v: 1, n: "ntf_3", k: "billing_cap_warning", w: "ws_1", o: "usage" }),
    ).toEqual({ v: 1, n: "ntf_3", k: "billing_cap_warning", w: "ws_1", o: "usage" });
  });

  test("a kind this build doesn't know still parses, so a newer API can add kinds", () => {
    expect(parsePushData({ ...question, k: "something_new" })?.k).toBe("something_new");
  });

  test("anything else is not version 1", () => {
    for (const raw of [
      null,
      undefined,
      "ponzu://canvas/cnv_1",
      {},
      { ...question, v: 2 },
      { ...question, v: "1" },
      { ...question, n: undefined },
      { ...question, n: "../x" },
      { ...question, c: "a".repeat(65) },
      { ...question, c: "cnv/1" },
      { ...question, p: "pg 1" },
      { ...question, q: 7 },
      { ...question, o: "pull_request" },
      { ...question, o: "everything" },
      { ...question, k: "Needs You" },
      { ...question, k: "" },
      // Only usage opens without a canvas.
      { v: 1, n: "ntf_1", k: "needs_you", o: "thread" },
    ]) {
      expect(parsePushData(raw)).toBeNull();
    }
  });
});

describe("where a tap goes", () => {
  test("each open, through the link grammar", () => {
    expect(linkOfPush(question)).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "thread",
      questionId: "q_1",
      notificationId: "ntf_1",
    });
    expect(linkOfPush({ v: 1, n: "ntf_2", k: "pr_ready", c: "cnv_1", o: "pull-request" })).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "pull-request",
      notificationId: "ntf_2",
    });
    expect(
      linkOfPush({
        v: 1,
        n: "ntf_3",
        k: "teammate_comment",
        c: "cnv_1",
        o: "comment",
        p: "pg_1",
        a: "ab_1",
        t: "ct_1",
      }),
    ).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "comment",
      pageId: "pg_1",
      artboardId: "ab_1",
      commentThreadId: "ct_1",
      notificationId: "ntf_3",
    });
    // Usage is Settings, whether or not a canvas rode along.
    expect(
      linkOfPush({ v: 1, n: "ntf_4", k: "billing_cap_reached", w: "ws_1", o: "usage" }),
    ).toEqual({
      kind: "settings",
      section: "usage",
      notificationId: "ntf_4",
    });
    expect(
      linkOfPush({ v: 1, n: "ntf_5", k: "billing_free_used", c: "cnv_1", o: "usage" }),
    ).toEqual({ kind: "settings", section: "usage", notificationId: "ntf_5" });
  });

  test("a tap's link survives being written and read again exactly", () => {
    const link = linkOfPush(question);
    const url = appLink(link, "ponzu");
    expect(url).toBe("ponzu://canvas/cnv_1?open=thread&question=q_1&n=ntf_1");
    expect(parseAppLink(url, "ponzu")).toEqual(link);
  });

  test("an older app on a newer ping still opens the canvas it names, and nothing else", () => {
    expect(linkOfPushData(question)).toEqual(linkOfPush(question));
    expect(linkOfPushData({ v: 2, c: "cnv_1", o: "somewhere" })).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
    });
    expect(linkOfPushData({ v: 2, c: "../cnv_1" })).toBeNull();
    expect(linkOfPushData({ v: 2 })).toBeNull();
    expect(linkOfPushData(null)).toBeNull();
    expect(linkOfPushData("cnv_1")).toBeNull();
  });
});

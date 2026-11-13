import { expect, test } from "bun:test";
import type { SessionState } from "@ponzu/client";
import { behaviorFor } from "./foreground";
import { canvasOf, dataOf, type PingLike, tapOf } from "./payload";
import { tapCanGo, tapIsStale, tapMove } from "./route";

/** A ping as expo-notifications hands it over from APNs: `body` as content.data, all as payload. */
const pushed = (body: unknown): PingLike => ({
  request: {
    content: { data: (body ?? {}) as Record<string, unknown> },
    trigger: { type: "push", payload: { aps: { alert: { title: "Pricing page" } }, body } },
  },
});
/** The same, with nothing in content.data: only the trigger's payload carries it. */
const payloadOnly = (body: unknown): PingLike => ({
  request: { content: { data: {} }, trigger: { type: "push", payload: { aps: {}, body } } },
});

const question = { v: 1, n: "ntf_1", k: "needs_you", c: "cnv_p", w: "ws_1", o: "thread", q: "q_7" };

test("a needs-you ping opens the chat at its question, and reads its notification", () => {
  const tap = tapOf(pushed(question));
  expect(tap.path).toBe("/canvas/cnv_p?sheet=chat&question=q_7&ping=ntf_1");
  expect(tap.canvasId).toBe("cnv_p");
  expect(tap.notificationId).toBe("ntf_1");
});

test("the data is read from content.data, or else from the trigger's payload", () => {
  expect(dataOf(pushed(question))).toEqual(question);
  expect(dataOf(payloadOnly(question))).toEqual(question);
  expect(tapOf(payloadOnly(question)).path).toBe(
    "/canvas/cnv_p?sheet=chat&question=q_7&ping=ntf_1",
  );
  expect(dataOf({ request: { content: { data: {} }, trigger: null } })).toBeNull();
});

test("each kind opens where notifications' contract says", () => {
  const ping = (o: string, rest: Record<string, string> = {}) =>
    tapOf(pushed({ v: 1, n: "ntf_2", k: "x", c: "cnv_p", o, ...rest })).path;
  expect(ping("thread")).toBe("/canvas/cnv_p?sheet=chat&ping=ntf_2");
  expect(ping("pull-request")).toBe("/canvas/cnv_p?sheet=pull-request&ping=ntf_2");
  expect(ping("comment", { p: "pg_1", a: "ab_1", t: "th_1" })).toBe(
    "/canvas/cnv_p?page=pg_1&artboard=ab_1&thread=th_1&ping=ntf_2",
  );
  expect(
    tapOf(pushed({ v: 1, n: "ntf_3", k: "billing_cap_reached", w: "ws_1", o: "usage" })).path,
  ).toBe("/settings?section=usage");
});

test("a ping a newer API sent opens the canvas it names; one naming nothing opens the canvases", () => {
  const newer = tapOf(pushed({ v: 2, c: "cnv_p", o: "somewhere_new" }));
  expect(newer.path).toBe("/canvas/cnv_p?ping=1");
  expect(newer.notificationId).toBeNull();
  for (const body of [
    null,
    "ponzu://canvas/cnv_p",
    { url: "evil://canvas/cnv_p?sheet=chat" },
    { url: "ponzu-dev://canvas/cnv_p" },
    { v: 1, n: "ntf_1", k: "needs_you", o: "thread" },
    { v: 1, n: "ntf_1", k: "needs_you", c: "../../etc", o: "thread" },
    { c: "cnv p" },
  ]) {
    const tap = tapOf(pushed(body));
    expect({ body, path: tap.path, route: tap.route }).toEqual({
      body,
      path: "/canvases",
      route: null,
    });
    expect(tapMove(tap, null)).toEqual({ kind: "canvases" });
  }
});

test("in the foreground, a ping about the canvas on screen shows nothing; any other, a silent banner", () => {
  const ping = pushed(question);
  expect(canvasOf(ping)).toBe("cnv_p");
  expect(behaviorFor(ping, "cnv_p")).toEqual({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: true,
  });
  for (const onScreen of ["cnv_other", null]) {
    expect(behaviorFor(ping, onScreen)).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    });
  }
  // One that names no canvas is never taken for the one on screen.
  expect(behaviorFor(pushed(null), "cnv_p").shouldShowBanner).toBe(true);
});

const maya = { status: "signed_in", user: { id: "usr_1" } } as unknown as SessionState;

test("a tap waits for the person signed in, through setup, off the launch screen", () => {
  const canvases = ["(tabs)", "(canvases)", "canvases"];
  expect(tapCanGo({ status: "loading" }, null, [])).toBe(false);
  expect(tapCanGo(maya, null, [])).toBe(false);
  expect(tapCanGo(maya, "done", [])).toBe(false);
  expect(tapCanGo(maya, "done", ["index"])).toBe(false);
  expect(tapCanGo(maya, "claude", ["setup", "claude"])).toBe(false);
  expect(tapCanGo({ status: "signed_out" }, "done", ["sign-in"])).toBe(false);
  expect(tapCanGo(maya, "done", canvases)).toBe(true);
  expect(tapCanGo(maya, "done", ["canvas", "[id]"])).toBe(true);
  expect(tapIsStale({ status: "signed_out" })).toBe(true);
  expect(tapIsStale({ status: "github_reauth" })).toBe(true);
  expect(tapIsStale({ status: "loading" })).toBe(false);
  expect(tapIsStale(maya)).toBe(false);
});

test("a tap for the canvas on screen opens over it in place; any other is pushed", () => {
  const tap = tapOf(pushed(question));
  expect(tapMove(tap, "cnv_p")).toEqual({
    kind: "params",
    params: {
      page: undefined,
      artboard: undefined,
      sheet: "chat",
      question: "q_7",
      thread: undefined,
      message: undefined,
      ping: "ntf_1",
    },
  });
  expect(tapMove(tap, "cnv_other")).toEqual({ kind: "push", path: tap.path });
  expect(tapMove(tap, null)).toEqual({ kind: "push", path: tap.path });
});

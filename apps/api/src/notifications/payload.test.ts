import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pingCopy, TITLE_MAX } from "./copy.ts";
import {
  badgeMessage,
  messageBytes,
  PUSH_MAX_BYTES,
  PushData,
  type PushNotification,
  pushMessage,
} from "./payload.ts";

const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
const canvasId = "cnv_7k2m9x4q0c8v5n1t";
const question = "What colour should the checkout button be, given the brand?";
const branch = "pz/secret-launch-plan";

function needsYou(canvasName: string): PushNotification {
  const { title, body } = pingCopy({ kind: "needs_you", canvasName, questionKind: "question" });
  return {
    id: "ntf_7k2m9x4q0c8v5n1t",
    kind: "needs_you",
    title,
    body,
    canvasId,
    workspaceId: "ws_7k2m9x4q0c8v5n1t",
    link: { open: "thread", questionId: "q_7k2m9x4q0c8v5n1t" },
  };
}

describe("the message", () => {
  test("its fields, exact", () => {
    expect(pushMessage(token, needsYou("Checkout"), 3)).toEqual({
      to: token,
      title: "Checkout",
      body: "Ponzu has a question for you.",
      sound: "default",
      badge: 3,
      threadId: canvasId,
      collapseId: "ntf_7k2m9x4q0c8v5n1t",
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
      data: {
        v: 1,
        n: "ntf_7k2m9x4q0c8v5n1t",
        k: "needs_you",
        c: canvasId,
        w: "ws_7k2m9x4q0c8v5n1t",
        o: "thread",
        q: "q_7k2m9x4q0c8v5n1t",
      },
    });
  });

  test("a teammate's comments replace one another; every other ping collapses by its own id", () => {
    const comment: PushNotification = {
      ...needsYou("Checkout"),
      kind: "teammate_comment",
      link: { open: "comment", pageId: "pg_1", artboardId: "ab_1", commentThreadId: "ti_1" },
    };
    const message = pushMessage(token, comment, 0);
    expect(message.collapseId).toBe(`${canvasId}:comments`);
    expect(message.data).toEqual({
      v: 1,
      n: "ntf_7k2m9x4q0c8v5n1t",
      k: "teammate_comment",
      c: canvasId,
      w: "ws_7k2m9x4q0c8v5n1t",
      o: "comment",
      p: "pg_1",
      a: "ab_1",
      t: "ti_1",
    });
    expect(pushMessage(token, needsYou("x"), 0).collapseId).toBe("ntf_7k2m9x4q0c8v5n1t");
  });

  test("a billing ping has no canvas, and groups by its workspace", () => {
    const { title, body } = pingCopy({
      kind: "billing_cap_warning",
      workspace: { name: "Northbrook", personal: false },
      capCents: 10_000,
    });
    const message = pushMessage(
      token,
      {
        id: "ntf_b",
        kind: "billing_cap_warning",
        title,
        body,
        canvasId: null,
        workspaceId: "ws_a",
        link: { open: "usage" },
      },
      0,
    );
    expect(message.threadId).toBe("ws_a");
    expect(message.data).toEqual({
      v: 1,
      n: "ntf_b",
      k: "billing_cap_warning",
      w: "ws_a",
      o: "usage",
    });
  });

  test("a badge-only push has no words and no sound", () => {
    expect(badgeMessage(token, 0)).toEqual({
      to: token,
      badge: 0,
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
    });
  });
});

describe("no text from the trigger", () => {
  test("data holds only its keys, each an id or a fixed word", () => {
    const message = pushMessage(token, needsYou("Checkout"), 1);
    const json = JSON.stringify(message);
    expect(json).not.toContain(question);
    expect(json).not.toContain(branch);
    expect(PushData.safeParse(message.data).success).toBe(true);
  });

  test("words smuggled in as an id are refused", () => {
    const smuggled = {
      ...needsYou("Checkout"),
      link: { open: "thread" as const, questionId: question },
    };
    expect(() => pushMessage(token, smuggled, 1)).toThrow();
    const branchy = { ...needsYou("Checkout"), canvasId: branch };
    expect(() => pushMessage(token, branchy, 1)).toThrow();
  });

  test("a field outside PushData v1 is refused", () => {
    expect(
      PushData.safeParse({ v: 1, n: "ntf_a", k: "reply", o: "thread", text: "hello" }).success,
    ).toBe(false);
    expect(PushData.safeParse({ v: 2, n: "ntf_a", k: "reply", o: "thread" }).success).toBe(false);
  });
});

describe("at most 4096 bytes", () => {
  test("a canvas name of 10,000 characters of the widest kind", () => {
    const wide = '"\\😀\u0000'.repeat(2_500);
    const message = pushMessage(token, needsYou(wide), 9999);
    expect(messageBytes(message)).toBeLessThanOrEqual(PUSH_MAX_BYTES);
    expect([...(message.title ?? "")].length).toBeLessThanOrEqual(TITLE_MAX);
  });

  test("a longer token than Expo makes still fits, by clipping the title further", () => {
    const longTo = `ExponentPushToken[${"x".repeat(3_700)}]`;
    const message = pushMessage(longTo, needsYou("😀".repeat(60)), 1);
    expect(messageBytes(message)).toBeLessThanOrEqual(PUSH_MAX_BYTES);
    expect(message.title?.endsWith("…")).toBe(true);
    expect(message.body).toBe("Ponzu has a question for you.");
  });

  test("any name and any ids of the longest shape fit", () => {
    const id = fc.stringMatching(/^[A-Za-z0-9_-]{64}$/);
    return fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 400 }), id, id, id, (name, n, c, q) => {
        const notification = {
          ...needsYou(name),
          id: n,
          canvasId: c,
          workspaceId: c,
          link: {
            open: "comment" as const,
            pageId: q,
            artboardId: q,
            commentThreadId: q,
            questionId: q,
          },
        };
        expect(messageBytes(pushMessage(token, notification, 99_999))).toBeLessThanOrEqual(
          PUSH_MAX_BYTES,
        );
      }),
      { seed: 20261110, numRuns: 300 },
    );
  });
});

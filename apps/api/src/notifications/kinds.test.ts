import { describe, expect, test } from "bun:test";
import {
  dedupeKey,
  FINISHED_MIN_MS,
  KIND_OPENS,
  KIND_TOGGLE,
  NOTIFICATION_KINDS,
  NotifyTrigger,
  QUESTION_ESCALATE_MS,
  RATE_EXEMPT_KINDS,
  triggerKey,
  turnPing,
} from "./kinds.ts";

describe("kinds", () => {
  test("the program's twelve kinds, and no mention or cap_80", () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      "needs_you",
      "reply",
      "finished",
      "failed",
      "claude_limit",
      "pr_ready",
      "pr_approved",
      "teammate_comment",
      "billing_free_used",
      "billing_cap_warning",
      "billing_cap_reached",
      "billing_payment_failed",
    ]);
  });

  test("each kind's toggle; billing is always on", () => {
    expect(KIND_TOGGLE).toEqual({
      needs_you: "needsYou",
      reply: "replies",
      finished: "needsYou",
      failed: "needsYou",
      claude_limit: "needsYou",
      pr_ready: "prReady",
      pr_approved: "prReady",
      teammate_comment: "teammateComments",
      billing_free_used: null,
      billing_cap_warning: null,
      billing_cap_reached: null,
      billing_payment_failed: null,
    });
  });

  test("needs-you and billing are exempt from the hourly limit, nothing else", () => {
    expect([...RATE_EXEMPT_KINDS].sort()).toEqual([
      "billing_cap_reached",
      "billing_cap_warning",
      "billing_free_used",
      "billing_payment_failed",
      "needs_you",
    ]);
  });

  test("where each opens", () => {
    expect(KIND_OPENS.needs_you).toBe("thread");
    expect(KIND_OPENS.pr_ready).toBe("pull-request");
    expect(KIND_OPENS.teammate_comment).toBe("comment");
    expect(KIND_OPENS.billing_cap_reached).toBe("usage");
  });

  test("the timings", () => {
    expect(QUESTION_ESCALATE_MS).toBe(300_000);
    expect(FINISHED_MIN_MS).toBe(60_000);
  });
});

describe("triggers carry ids only", () => {
  const raised = {
    kind: "question_raised",
    canvasId: "des_7k2m9x4q0c8v5n1t",
    questionId: "q_7k2m9x4q0c8v5n1t",
    questionKind: "question",
  };

  test("a well-formed trigger parses", () => {
    expect(NotifyTrigger.parse(raised)).toEqual(raised as NotifyTrigger);
    expect(
      NotifyTrigger.parse({
        kind: "pull_request_ready",
        canvasId: "cnv_7k2m9x4q0c8v5n1t",
        number: 12,
        headSha: "a".repeat(40),
        authorLogin: "ponzu-design[bot]",
      }).kind,
    ).toBe("pull_request_ready");
  });

  test("a field that is not in the schema is refused, so no text rides along", () => {
    expect(NotifyTrigger.safeParse({ ...raised, text: "What colour?" }).success).toBe(false);
    expect(
      NotifyTrigger.safeParse({
        kind: "comment_posted",
        canvasId: "cnv_a",
        messageId: "ti_a",
        authorId: "usr_a",
        body: "Looks great",
      }).success,
    ).toBe(false);
  });

  test("an id that is words is refused", () => {
    expect(
      NotifyTrigger.safeParse({ ...raised, questionId: "What colour should it be?" }).success,
    ).toBe(false);
    expect(NotifyTrigger.safeParse({ ...raised, canvasId: "x".repeat(65) }).success).toBe(false);
    expect(NotifyTrigger.safeParse({ ...raised, canvasId: "" }).success).toBe(false);
  });

  test("a branch can't pass as a sha or a login", () => {
    const ready = {
      kind: "pull_request_ready",
      canvasId: "cnv_a",
      number: 12,
      headSha: "pz/secret-launch",
      authorLogin: null,
    };
    expect(NotifyTrigger.safeParse(ready).success).toBe(false);
    expect(
      NotifyTrigger.safeParse({ ...ready, headSha: "b".repeat(40), authorLogin: "pz/secret" })
        .success,
    ).toBe(false);
  });

  test("an unknown error code is refused", () => {
    const report = {
      kind: "turn_finished",
      canvasId: "cnv_a",
      turnId: "0b6f3c2e-6a0e-4f61-9d39-0f1f2a3b4c5d",
      eventId: "evt_a",
      outcome: "failed",
      errorCode: "claude_limit",
      durationMs: 1000,
    };
    expect(NotifyTrigger.safeParse(report).success).toBe(true);
    expect(NotifyTrigger.safeParse({ ...report, errorCode: "Claude said: no" }).success).toBe(
      false,
    );
  });

  test("a billing trigger, as refreshBillingGate calls it", () => {
    const trigger = NotifyTrigger.parse({
      kind: "billing",
      workspaceId: "ws_a",
      periodStart: "2026-11-09T00:00:00.000Z",
      notice: "cap_warning",
      amountCents: 10_000,
    });
    expect(triggerKey(trigger)).toBe("billing:cap_warning:ws_a:2026-11-09T00:00:00.000Z");
  });

  test("a billing amount comes with every notice but free credits used", () => {
    const billing = {
      kind: "billing",
      workspaceId: "ws_a",
      periodStart: "2026-11-09T00:00:00.000Z",
    };
    const ok = (notice: string, amountCents: number | null) =>
      NotifyTrigger.safeParse({ ...billing, notice, amountCents }).success;
    expect(ok("free_used", null)).toBe(true);
    expect(ok("free_used", 0)).toBe(false);
    expect(ok("cap_reached", null)).toBe(false);
    expect(ok("payment_failed", null)).toBe(false);
    expect(ok("payment_failed", 15_000)).toBe(true);
  });

  test("each trigger's job key", () => {
    expect(triggerKey(NotifyTrigger.parse(raised))).toBe(
      "question_raised:des_7k2m9x4q0c8v5n1t:q_7k2m9x4q0c8v5n1t",
    );
    expect(
      triggerKey({
        kind: "pull_request_ready",
        canvasId: "c",
        number: 7,
        headSha: "f".repeat(40),
        authorLogin: null,
      }),
    ).toBe(`pull_request_ready:c:7:${"f".repeat(40)}`);
    expect(
      triggerKey({ kind: "wake_failed", canvasId: "c", failedAt: "2026-11-10T12:00:00.000Z" }),
    ).toBe("wake_failed:c:2026-11-10T12:00:00.000Z");
  });

  test("dedupe keys", () => {
    expect(dedupeKey.needsYou("c", "q")).toBe("needs_you:c:q");
    expect(dedupeKey.prReady("c", 12, "abc")).toBe("pr_ready:c:12:abc");
    expect(dedupeKey.comment("c", "m")).toBe("comment:c:m");
    expect(dedupeKey.billing("cap_reached", "ws", "2026-11-09T00:00:00.000Z")).toBe(
      "billing:cap_reached:ws:2026-11-09T00:00:00.000Z",
    );
    // A Claude limit pings once a UTC day per account.
    expect(dedupeKey.claudeLimit("cla_a", new Date("2026-11-10T23:59:59.999Z"))).toBe(
      "limit:cla_a:2026-11-10",
    );
    expect(dedupeKey.claudeLimit("cla_a", new Date("2026-11-11T00:00:00.000Z"))).toBe(
      "limit:cla_a:2026-11-11",
    );
  });
});

describe("what a turn report pings", () => {
  const base = {
    outcome: "completed" as const,
    errorCode: null,
    durationMs: 120_000,
    eventKind: "message" as const,
    questionOpen: false,
  };

  test("a comment's turn is a reply, however short", () => {
    expect(turnPing({ ...base, eventKind: "comment", durationMs: 1 })).toEqual({ kind: "reply" });
  });

  test("a message's or an answer's turn finished after more than a minute", () => {
    expect(turnPing(base)).toEqual({ kind: "finished" });
    expect(turnPing({ ...base, eventKind: "answer" })).toEqual({ kind: "finished" });
    expect(turnPing({ ...base, durationMs: 60_001 })).toEqual({ kind: "finished" });
    // Exactly a minute is not more than a minute.
    expect(turnPing({ ...base, durationMs: 60_000 })).toBeNull();
  });

  test("finished is not sent while a question is open", () => {
    expect(turnPing({ ...base, questionOpen: true })).toBeNull();
  });

  test("a stop pings nothing, even after failing", () => {
    expect(turnPing({ ...base, outcome: "stopped" })).toBeNull();
  });

  test("failures", () => {
    expect(turnPing({ ...base, outcome: "failed", errorCode: "claude_limit" })).toEqual({
      kind: "claude_limit",
    });
    expect(turnPing({ ...base, outcome: "failed", errorCode: "claude_auth" })).toEqual({
      kind: "failed",
      reason: "claude_auth",
    });
    expect(turnPing({ ...base, outcome: "failed", errorCode: "turn_failed" })).toEqual({
      kind: "failed",
      reason: "turn",
    });
    expect(turnPing({ ...base, outcome: "failed", errorCode: null, durationMs: 5 })).toEqual({
      kind: "failed",
      reason: "turn",
    });
  });

  test("a turn no message began, or an edit's, pings nothing", () => {
    expect(turnPing({ ...base, eventKind: null })).toBeNull();
    expect(turnPing({ ...base, eventKind: "edit" })).toBeNull();
    expect(turnPing({ ...base, eventKind: "check" })).toBeNull();
    expect(turnPing({ ...base, eventKind: "review" })).toBeNull();
  });
});

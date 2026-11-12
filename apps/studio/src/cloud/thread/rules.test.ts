import { expect, test } from "bun:test";
import type { Person } from "../model.ts";
import {
  clearDrafts,
  composerButton,
  composerHolds,
  readDraft,
  restoreDraft,
  writeDraft,
} from "./composer-rules.ts";
import { FOLLOWING, type Follow, follow } from "./follow.ts";

// The rail's rows are tested with their rules, in packages/client/src/model/thread.test.ts.

const bryce: Person = { id: "bryce", name: "bryce", login: "bryce", avatarUrl: null };

test("following: scrolling up stops it, the foot or a jump starts it again", () => {
  const foot = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
  const up = { ...foot, scrollTop: 300 };
  let state: Follow = FOLLOWING;
  state = follow(state, { type: "scrolled", metrics: up });
  expect(state).toEqual({ following: false, unseen: 0 });
  state = follow(state, { type: "arrived", count: 2, mine: false });
  state = follow(state, { type: "arrived", count: 1, mine: false });
  expect(state).toEqual({ following: false, unseen: 3 });
  // Near enough to the foot counts as at it.
  expect(follow(state, { type: "scrolled", metrics: { ...foot, scrollTop: 590 } })).toEqual(
    FOLLOWING,
  );
  expect(follow(state, { type: "jumped" })).toEqual(FOLLOWING);
  // Your own message takes you to the foot, wherever you were.
  expect(follow(state, { type: "arrived", count: 1, mine: true })).toEqual(FOLLOWING);
  // While following, arrivals are seen as they come.
  expect(follow(FOLLOWING, { type: "arrived", count: 4, mine: false })).toEqual(FOLLOWING);
});

test("Stop while working with nothing typed; Send once there is something to send", () => {
  const ready = { id: "a", name: "a.png", previewUrl: "", status: "ready" } as const;
  const uploading = { ...ready, status: "uploading" } as const;
  const base = { working: false, text: "", attachments: [], gate: null };
  expect(composerButton(base)).toBe("waiting");
  expect(composerButton({ ...base, working: true })).toBe("stop");
  expect(composerButton({ ...base, working: true, text: "  " })).toBe("stop");
  expect(composerButton({ ...base, working: true, text: "Keep the green" })).toBe("send");
  expect(composerButton({ ...base, text: "Keep the green" })).toBe("send");
  // An image alone says nothing; one still uploading holds the message back.
  expect(composerButton({ ...base, attachments: [ready] })).toBe("waiting");
  expect(composerButton({ ...base, text: "this", attachments: [ready, uploading] })).toBe(
    "waiting",
  );
  // While the owner's plan is at its limit a message still sends: it waits in the feed and goes
  // in at the reset. A run still going can be stopped.
  const gate = { kind: "claude_limit", owner: bryce, until: "2026-11-10T21:00:00Z" } as const;
  expect(composerHolds(gate)).toBe(false);
  expect(composerButton({ ...base, text: "hello", gate })).toBe("send");
  expect(composerButton({ ...base, text: "this", attachments: [ready], gate })).toBe("send");
  expect(composerButton({ ...base, working: true, gate })).toBe("stop");
  // While it waits on the owner's Claude being connected, nothing sends.
  const signedOut = { kind: "claude_expired", owner: bryce } as const;
  expect(composerHolds(signedOut)).toBe(true);
  expect(composerButton({ ...base, text: "hello", gate: signedOut })).toBe("waiting");
  expect(composerButton({ ...base, working: true, gate: signedOut })).toBe("stop");
});

test("drafts are kept per person and canvas, and signing out clears them", () => {
  writeDraft("bryce", "cnv_hero", "Calmer, and keep the green");
  writeDraft("maya", "cnv_hero", "Try the serif smaller");
  expect(readDraft("bryce", "cnv_hero")).toBe("Calmer, and keep the green");
  // Someone else signed in on the same Mac sees their own draft, not yours.
  expect(readDraft("maya", "cnv_hero")).toBe("Try the serif smaller");
  expect(readDraft("bryce", "cnv_other")).toBe("");
  clearDrafts();
  expect(readDraft("bryce", "cnv_hero")).toBe("");
  expect(readDraft("maya", "cnv_hero")).toBe("");
});

test("a message that failed to send comes back ahead of what was typed since", () => {
  expect(restoreDraft("Keep the green", "")).toBe("Keep the green");
  expect(restoreDraft("Keep the green", "  ")).toBe("Keep the green");
  expect(restoreDraft("Keep the green", "and the photo")).toBe("Keep the green\nand the photo");
});

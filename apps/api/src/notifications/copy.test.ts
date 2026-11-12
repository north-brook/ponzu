import { describe, expect, test } from "bun:test";
import { QUESTION_KINDS } from "@ponzu/db/types";
import {
  CLAUDE_LIMIT_BODY,
  clip,
  commentBody,
  FAILED_BODY,
  FINISHED_BODY,
  firstName,
  NEEDS_YOU_BODY,
  pingCopy,
  REPLY_BODY,
  TITLE_MAX,
  titleOf,
} from "./copy.ts";
import { NOTIFICATION_KINDS } from "./kinds.ts";

const maya = { userId: "usr_maya", name: "Maya Lin", login: "maya" };
const sam = { userId: "usr_sam", name: "Sam", login: "sam" };
const lee = { userId: "usr_lee", name: "Lee Ann Park", login: "lee" };
const kai = { userId: "usr_kai", name: null, login: "kai-dev" };
const team = { name: "Northbrook", personal: false };
const personal = { name: "Maya's workspace", personal: true };
const dec9 = new Date("2026-12-09T00:00:00Z");

describe("every sentence, exact", () => {
  test("needs you, by question kind", () => {
    expect(NEEDS_YOU_BODY).toEqual({
      question: "Ponzu has a question for you.",
      plan: "Ponzu has a plan for you to look at.",
      permission: "Ponzu is asking for your permission.",
      elicitation: "Ponzu needs a few details from you.",
      handoff: "Ponzu needs you to open a link.",
      secret: "Ponzu needs a secret to go on.",
    });
    // Every question the runner can raise has its sentence.
    expect(Object.keys(NEEDS_YOU_BODY).sort()).toEqual([...QUESTION_KINDS].sort());
  });

  test("turns", () => {
    expect(REPLY_BODY).toBe("Ponzu replied to your comment.");
    expect(FINISHED_BODY).toBe("Ponzu finished what you asked.");
    expect(FAILED_BODY).toEqual({
      turn: "Ponzu stopped before it finished. Open the thread to see why.",
      claude_auth: "Ponzu can't reach your Claude account. Connect it again to go on.",
      lapsed: "Ponzu couldn't get to your message. Send it again.",
      wake: "Ponzu couldn't start. Send a message to try again.",
    });
    expect(CLAUDE_LIMIT_BODY).toBe("Your Claude plan hit a limit. Canvases wait until it resets.");
  });

  test("each kind's title and body", () => {
    const canvasName = "Checkout flow";
    expect(pingCopy({ kind: "needs_you", canvasName, questionKind: "plan" })).toEqual({
      title: "Checkout flow",
      body: "Ponzu has a plan for you to look at.",
    });
    expect(pingCopy({ kind: "reply", canvasName }).body).toBe("Ponzu replied to your comment.");
    expect(pingCopy({ kind: "finished", canvasName }).body).toBe("Ponzu finished what you asked.");
    expect(pingCopy({ kind: "failed", canvasName, reason: "wake" }).body).toBe(
      "Ponzu couldn't start. Send a message to try again.",
    );
    expect(pingCopy({ kind: "claude_limit", canvasName }).body).toBe(
      "Your Claude plan hit a limit. Canvases wait until it resets.",
    );
    expect(pingCopy({ kind: "pr_ready", canvasName, number: 12 })).toEqual({
      title: "Checkout flow",
      body: "Pull request #12 is ready to merge.",
    });
    expect(pingCopy({ kind: "pr_approved", canvasName, number: 12, approver: maya }).body).toBe(
      "Maya approved pull request #12.",
    );
    expect(pingCopy({ kind: "teammate_comment", canvasName, people: [maya], count: 1 }).body).toBe(
      "Maya commented.",
    );
  });

  test("billing, for a team: billing's words, titled with the workspace", () => {
    expect(pingCopy({ kind: "billing_free_used", workspace: team })).toEqual({
      title: "Northbrook",
      body: "Northbrook has used this month's free credits.",
    });
    expect(pingCopy({ kind: "billing_cap_warning", workspace: team, capCents: 10_000 }).body).toBe(
      "Northbrook has used 80% of this month's $100 cap.",
    );
    expect(
      pingCopy({ kind: "billing_cap_reached", workspace: team, capCents: 10_000, resetsOn: dec9 })
        .body,
    ).toBe(
      "Northbrook reached this month's $100 cap. Canvases wait until it's raised or it resets on December 9.",
    );
    expect(
      pingCopy({ kind: "billing_payment_failed", workspace: team, totalCents: 15_000 }).body,
    ).toBe("Northbrook's payment of $150.00 didn't go through.");
  });

  test("billing, for a personal workspace: You've and Your", () => {
    expect(pingCopy({ kind: "billing_free_used", workspace: personal }).body).toBe(
      "You've used this month's free credits.",
    );
    expect(
      pingCopy({ kind: "billing_cap_warning", workspace: personal, capCents: 5_000 }).body,
    ).toBe("You've used 80% of this month's $50 cap.");
    expect(
      pingCopy({
        kind: "billing_cap_reached",
        workspace: personal,
        capCents: 125_000,
        resetsOn: new Date("2027-02-28T00:00:00Z"),
      }).body,
    ).toBe(
      "You've reached this month's $1,250 cap. Canvases wait until it's raised or it resets on February 28.",
    );
    expect(
      pingCopy({ kind: "billing_payment_failed", workspace: personal, totalCents: 123_456 }).body,
    ).toBe("Your payment of $1,234.56 didn't go through.");
  });

  test("the reset day is the period's midnight UTC, wherever the API runs", () => {
    // Midnight UTC on the 1st is still the 1st, though it is the 31st's evening in New York.
    expect(
      pingCopy({
        kind: "billing_cap_reached",
        workspace: team,
        capCents: 100,
        resetsOn: new Date("2027-01-01T00:00:00Z"),
      }).body,
    ).toEndWith("resets on January 1.");
  });

  test("Ponzu speaks, never Claude's agent, and nothing says push", () => {
    const bodies = [
      ...Object.values(NEEDS_YOU_BODY),
      ...Object.values(FAILED_BODY),
      REPLY_BODY,
      FINISHED_BODY,
      CLAUDE_LIMIT_BODY,
    ];
    for (const body of bodies) {
      expect(body.toLowerCase()).not.toContain("push");
      expect(body.endsWith(".")).toBe(true);
    }
    // Every kind has words.
    expect(NOTIFICATION_KINDS.length).toBe(12);
  });
});

describe("titles", () => {
  test("a name of 60 characters or fewer is kept whole", () => {
    const sixty = "a".repeat(60);
    expect(titleOf(sixty)).toBe(sixty);
  });

  test("a longer name is clipped to 60 with an ellipsis", () => {
    const title = titleOf("b".repeat(61));
    expect(title).toBe(`${"b".repeat(59)}…`);
    expect([...title].length).toBe(TITLE_MAX);
  });

  test("a clip drops the space before its ellipsis", () => {
    expect(titleOf(`${"c".repeat(58)} dddd`)).toBe(`${"c".repeat(58)}…`);
  });

  test("a clip never splits what a person sees as one character", () => {
    const family = "👨‍👩‍👧‍👦"; // seven code points, one grapheme
    const title = titleOf(`${"e".repeat(55)}${family}tail`);
    expect(title).toBe(`${"e".repeat(55)}…`);
    const accented = "e\u0301"; // e with a combining acute
    expect(titleOf(`${"f".repeat(58)}${accented}${accented}`)).toBe(`${"f".repeat(58)}…`);
  });

  test("newlines, tabs and direction overrides are not shown", () => {
    expect(titleOf("  Checkout\n\tflow\u202E evil  ")).toBe("Checkout flow evil");
  });

  test("an empty name reads Untitled", () => {
    expect(titleOf("  \n ")).toBe("Untitled");
  });

  test("clip counts code points, as Postgres does", () => {
    expect(clip("😀".repeat(10), 10)).toBe("😀".repeat(10));
    expect(clip("😀".repeat(11), 10)).toBe(`${"😀".repeat(9)}…`);
  });
});

describe("first names", () => {
  test("the name up to its first space", () => {
    expect(firstName(maya)).toBe("Maya");
    expect(firstName(lee)).toBe("Lee");
    expect(firstName({ name: "  Sam  Ortiz ", login: "s" })).toBe("Sam");
  });

  test("no name: the login, with its @", () => {
    expect(firstName(kai)).toBe("@kai-dev");
    expect(firstName({ name: "   ", login: "kai-dev" })).toBe("@kai-dev");
  });

  test("neither: Someone", () => {
    expect(firstName({ name: null, login: null })).toBe("Someone");
  });

  test("a name is one line, and clipped", () => {
    expect(firstName({ name: "Maya\nApproved", login: "m" })).toBe("Maya");
    expect(firstName({ name: "x".repeat(80), login: "m" })).toBe(`${"x".repeat(31)}…`);
  });
});

describe("a teammate's comments, collapsed", () => {
  test("one comment, then several from one person", () => {
    expect(commentBody([maya], 1)).toBe("Maya commented.");
    expect(commentBody([maya], 2)).toBe("Maya left 2 comments.");
  });

  test("two people", () => {
    expect(commentBody([maya, sam], 2)).toBe("Maya and Sam left 2 comments.");
    expect(commentBody([maya, sam], 3)).toBe("Maya and Sam left 3 comments.");
  });

  test("three people are each named", () => {
    expect(commentBody([maya, sam, lee], 3)).toBe("Maya, Sam and Lee left 3 comments.");
  });

  test("four or more: two named and the others counted", () => {
    expect(commentBody([maya, sam, lee, kai], 5)).toBe("Maya, Sam and 2 others left 5 comments.");
    expect(
      commentBody([maya, sam, lee, kai, { userId: "usr_ana", name: "Ana", login: "ana" }], 9),
    ).toBe("Maya, Sam and 3 others left 9 comments.");
  });

  test("someone listed twice is counted once", () => {
    expect(commentBody([maya, maya], 2)).toBe("Maya left 2 comments.");
    expect(commentBody([maya, sam, lee, kai, maya], 9)).toBe(
      "Maya, Sam and 2 others left 9 comments.",
    );
  });

  test("a person is their user id, not their name", () => {
    const renamed = { ...maya, name: "Maya L." };
    expect(commentBody([maya, renamed], 2)).toBe("Maya left 2 comments.");
    const otherSam = { userId: "usr_sam2", name: "Sam", login: null };
    expect(commentBody([sam, otherSam], 2)).toBe("Sam and Sam left 2 comments.");
  });

  test("never fewer comments than people", () => {
    expect(commentBody([maya, sam], 1)).toBe("Maya and Sam left 2 comments.");
  });
});

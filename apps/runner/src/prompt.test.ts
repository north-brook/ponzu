import { expect, test } from "bun:test";
import { ADA } from "./api/fake.ts";
import type { EventBody, Person, RunnerEvent } from "./api/protocol.ts";
import { eventText, noticeText } from "./prompt.ts";

function event(body: EventBody, from: Person | null = ADA): Exclude<RunnerEvent, { kind: "stop" }> {
  return { id: "evt_1", seq: 1, at: "", priority: "now", from, ...body } as Exclude<
    RunnerEvent,
    { kind: "stop" }
  >;
}

const comment = {
  threadId: "th_1",
  messageId: "m_1",
  text: "Calmer, please.",
  reply: false,
  artboardId: "ab_hero",
  artboardName: "Hero · B",
  nodeId: null,
};

test("a message says who wrote it, then their words as written", () => {
  expect(
    eventText(event({ kind: "message", payload: { text: "Three takes.\nKeep the green." } })),
  ).toBe("Message from Ada:\nThree takes.\nKeep the green.");
});

test("a comment says where it is, with the ids the tools take", () => {
  expect(eventText(event({ kind: "comment", payload: comment }))).toBe(
    'Comment from Ada on "Hero · B" (artboard ab_hero), thread th_1:\nCalmer, please.',
  );
  expect(eventText(event({ kind: "comment", payload: { ...comment, nodeId: "n_h1" } }))).toBe(
    'Comment from Ada on "Hero · B" (artboard ab_hero), thread th_1:\nCalmer, please.\nIt is pinned to node n_h1.',
  );
  expect(eventText(event({ kind: "comment", payload: { ...comment, reply: true } }))).toBe(
    'Reply from Ada in comment thread th_1 on "Hero · B" (artboard ab_hero):\nCalmer, please.',
  );
  const loose = { ...comment, artboardId: null, artboardName: null };
  expect(eventText(event({ kind: "comment", payload: loose }))).toBe(
    "Comment from Ada on the open canvas, thread th_1:\nCalmer, please.",
  );
});

test("a canvas edit says what changed and on which boards", () => {
  expect(
    eventText(
      event({
        kind: "edit",
        payload: {
          summary: 'renamed "Hero" to "Hero · A"',
          artboards: [{ id: "ab_1", name: "Hero · A" }],
        },
      }),
    ),
  ).toBe('Canvas edit by Ada: renamed "Hero" to "Hero · A"\nArtboards: "Hero · A" (ab_1)');
  expect(
    eventText(event({ kind: "edit", payload: { summary: "added a page", artboards: [] } })),
  ).toBe("Canvas edit by Ada: added a page");
});

test("a failed check and a review come from GitHub, with their links", () => {
  expect(
    eventText(
      event(
        {
          kind: "check",
          payload: { name: "lint", conclusion: "timed_out", url: null, summary: null },
        },
        null,
      ),
    ),
  ).toBe('A check failed on the pull request: "lint" (timed out).');
  expect(
    eventText(
      event({
        kind: "review",
        payload: {
          state: "changes_requested",
          body: "Tighten the copy.",
          url: "https://github.com/n/f/pull/4#r1",
          comments: 2,
        },
      }),
    ),
  ).toBe(
    "Review from Ada on the pull request: asked for changes, with 2 line comments.\nDetails: https://github.com/n/f/pull/4#r1\nTighten the copy.",
  );
});

test("an answer nobody waits for says what it answers", () => {
  expect(
    eventText(
      event({ kind: "answer", payload: { questionId: "q_1", approved: false, note: "Not yet." } }),
    ),
  ).toBe("Ada said no to your request q_1.\nNot yet.");
  expect(eventText(event({ kind: "answer", payload: { questionId: "q_1", approved: true } }))).toBe(
    "Ada said yes to your request q_1.",
  );
});

test("notices the agent missed come together, from Ponzu", () => {
  expect(noticeText(["Undone: an edit…", "Removed: a script."])).toBe(
    "From Ponzu, about your last turn:\n\nUndone: an edit…\n\nRemoved: a script.",
  );
});

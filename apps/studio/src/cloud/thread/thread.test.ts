import { expect, test } from "bun:test";
import type { AgentActivity, Person, ThreadItem, TurnRecord } from "../model.ts";
import {
  clearDrafts,
  composerButton,
  readDraft,
  restoreDraft,
  writeDraft,
} from "./composer-rules.ts";
import { FOLLOWING, type Follow, follow } from "./follow.ts";
import { SENT_GRACE_MS, type ThreadRow, threadRows, workingLine } from "./thread.ts";

const person = (id: string): Person => ({ id, name: id, login: id, avatarUrl: null });
const bryce = person("bryce");
const maya = person("maya");

let seq = 0;
const item = (content: Omit<ThreadItem, "id" | "seq" | "at" | "streaming">, streaming = false) =>
  ({ id: `ti_${++seq}`, seq, at: "2026-11-10T16:00:00Z", streaming, ...content }) as ThreadItem;
const message = (from: Person, text = "hi") =>
  item({ kind: "message", payload: { text, from, attachments: [] } });
const reply = (text: string, streaming = false) =>
  item({ kind: "assistant", payload: { text } }, streaming);

const working: AgentActivity = { state: "working", status: "Working on it" };
const idle: AgentActivity = { state: "idle", status: null };

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

const turnItem = (record: Partial<TurnRecord>, streaming: boolean, label = "Thinking") =>
  item(
    {
      kind: "tool",
      payload: {
        label,
        steps: 4,
        artboards: ["ab_1", "ab_2"],
        turn: { ended: null, ms: 0, final: null, boards: 0, files: 0, log: [], ...record },
      },
    },
    streaming,
  );
/** Each row as its kind, and an aside as "aside" (with "+" when it sits under another). */
const lines = (rows: ThreadRow[]) =>
  rows.map((r) => (r.aside ? (r.asideContinues ? "aside+" : "aside") : r.item.kind));
const ids = (rows: ThreadRow[]) => rows.map((r) => r.item.id);

test("the working line: the agent's state while it works, never blank, gone once the turn ends", () => {
  const ask = message(bryce);
  const open = turnItem({}, true);
  const items = [ask, open, reply("On it.")];
  expect(workingLine(items, working)).toBe("Working on it");
  // Text streaming, or just sent and the next call not yet made: still a line.
  expect(workingLine([...items, reply("Folding", true)], working)).toBe("Working on it");
  expect(workingLine(items, { state: "working", status: null })).toBe("Thinking");
  expect(workingLine(items, { state: "waking", status: null })).toBe("Waking up");
  // The question is in the composer while it waits; no working line.
  expect(workingLine(items, { state: "needs_you", status: null })).toBeNull();
  // The turn has ended in the thread: no line, even before the head says idle.
  const ended = [ask, turnItem({ ended: "done" }, false), reply("Done.")];
  expect(workingLine(ended, working)).toBeNull();
  // A person spoke since: whatever the head says is for them.
  expect(workingLine([...ended, message(maya)], working)).toBe("Working on it");
  expect(workingLine(ended, idle)).toBeNull();
});

test("between a send and the agent's first word, the line says it is thinking, for a while", () => {
  const now = Date.parse("2026-11-10T16:00:05Z");
  const earlier = reply("Earlier.");
  const sent = message(bryce);
  expect(workingLine([earlier, sent], idle, now)).toBe("Thinking");
  expect(workingLine([earlier, sent], idle, now + SENT_GRACE_MS)).toBeNull();
  const sending = {
    ...sent,
    payload: { ...sent.payload, delivery: "sending" },
  } as ThreadItem;
  expect(workingLine([sending], idle, now + SENT_GRACE_MS)).toBe("Thinking");
  const failed = { ...sent, payload: { ...sent.payload, delivery: "failed" } } as ThreadItem;
  expect(workingLine([failed], idle, now)).toBeNull();
  // Once the agent has answered, nothing.
  expect(workingLine([sent, reply("Hi.")], idle, now)).toBeNull();
  // A runner's word that it started is no answer: the line stays for the rest of the while.
  const resumed = item({ kind: "notice", payload: { type: "resumed" } });
  expect(workingLine([sent, resumed], idle, now)).toBe("Thinking");
  // An error the agent or Ponzu wrote is one: the thread says what happened.
  const lapsed = item({
    kind: "notice",
    payload: { type: "error", code: "turn_failed", message: "Claude was cut off." },
  });
  expect(workingLine([sent, resumed, lapsed], idle, now)).toBeNull();
});

test("a running turn shows what it says as asides, its newest words plain, and none of its work", () => {
  const ask = message(bryce, "Two boards and a file");
  const first = reply("Drawing them.");
  const second = reply("Now the file.");
  const third = reply("Done: two boards and the token file.");
  const log = [
    { after: null, text: "Read the canvas", count: 1 },
    { after: first.id, text: 'Drew "Hero"', count: 2 },
    { after: second.id, text: "Edited styles/tokens.css", count: 1 },
  ];
  const running = turnItem({ log }, true);
  // Its newest words, with nothing after them yet, read as an answer.
  expect(lines(threadRows([ask, running, first, second, third], working))).toEqual([
    "message",
    "aside",
    "aside+",
    "assistant",
  ]);
  // Once it goes on working after them, they are an aside too.
  const on = turnItem({ log: [...log, { after: third.id, text: "Committed", count: 1 }] }, true);
  expect(
    lines(threadRows([ask, { ...on, id: running.id }, first, second, third], working)),
  ).toEqual(["message", "aside", "aside+", "aside+"]);
  // Waiting on a question is still the turn running.
  const asking = turnItem({ log: log.slice(0, 2) }, true);
  expect(
    lines(threadRows([ask, asking, first, second], { state: "needs_you", status: null })),
  ).toEqual(["message", "aside", "assistant"]);
});

test("a finished turn keeps only its answer: the asides go, and the work never showed", () => {
  const ask = message(bryce, "Two boards and a file");
  const first = reply("Drawing them.");
  const second = reply("Now the file.");
  const final = reply("Done: two boards and the token file.");
  const log = [{ after: first.id, text: 'Drew "Hero"', count: 2 }];
  const done = turnItem({ ended: "done", ms: 125_000, final: final.id, log }, false);
  const rows = threadRows([ask, done, first, second, final], working);
  expect(ids(rows)).toEqual([ask.id, final.id]);
  expect(rows.every((r) => !r.aside)).toBe(true);
  // The same once the head says idle, and for a thread opened later.
  expect(ids(threadRows([ask, done, first, second, final], idle))).toEqual([ask.id, final.id]);
  expect(ids(threadRows([ask, done, first, second, final]))).toEqual([ask.id, final.id]);
});

test("a single reply is its own answer; a stopped or failed turn leaves how it ended", () => {
  const ask = message(bryce);
  const only = reply("Sure.");
  expect(
    lines(threadRows([ask, turnItem({ ended: "done", final: only.id }, false), only])),
  ).toEqual(["message", "assistant"]);
  const said = reply("Starting.");
  const stop = item({ kind: "notice", payload: { type: "stopped", by: bryce } });
  const stopped = [
    ask,
    turnItem(
      { ended: "stopped", log: [{ after: said.id, text: "Read comments", count: 3 }] },
      false,
    ),
    said,
    stop,
  ];
  expect(ids(threadRows(stopped))).toEqual([ask.id, stop.id]);
  const error = item({
    kind: "notice",
    payload: { type: "error", code: "turn_failed", message: "Overloaded" },
  });
  const failed = [
    ask,
    turnItem({ ended: "failed", log: [{ after: said.id, text: "Edited a.ts", count: 1 }] }, false),
    said,
    error,
  ];
  expect(ids(threadRows(failed))).toEqual([ask.id, error.id]);
});

test("a turn that ended as it meant to, but with work after its last words, keeps those words", () => {
  const ask = message(bryce);
  const first = reply("Looking.");
  const last = reply("Drawing it now.");
  const done = turnItem(
    { ended: "done", final: null, log: [{ after: last.id, text: "Drew x", count: 1 }] },
    false,
  );
  expect(ids(threadRows([ask, done, first, last]))).toEqual([ask.id, last.id]);
  // The head says idle a moment before the thread closes the turn: the same words stay, so
  // nothing goes and comes back when the record arrives.
  const open = turnItem({ log: [{ after: first.id, text: "Drew x", count: 1 }] }, true);
  expect(ids(threadRows([ask, open, first, last], idle))).toEqual([ask.id, last.id]);
  const closed = turnItem(
    { ended: "done", final: last.id, log: [{ after: first.id, text: "Drew x", count: 1 }] },
    false,
  );
  expect(ids(threadRows([ask, { ...closed, id: open.id }, first, last], idle))).toEqual([
    ask.id,
    last.id,
  ]);
});

test("questions stay where they were asked; the one a turn ends on is its last line", () => {
  const ask = message(bryce);
  const first = reply("Looking.");
  const question = (text: string) =>
    item({
      kind: "notice",
      payload: { type: "question", questionId: `q_${text}`, header: "Q", text },
    });
  const onTheWay = question("Which hero?");
  const final = reply("Here it is.");
  const atEnd = question("Ship it?");
  const rows = threadRows([
    ask,
    turnItem(
      { ended: "done", final: final.id, log: [{ after: first.id, text: "Drew x", count: 1 }] },
      false,
    ),
    first,
    onTheWay,
    final,
    atEnd,
  ]);
  expect(ids(rows)).toEqual([ask.id, onTheWay.id, final.id, atEnd.id]);
});

test("an older runner's thread: asides while it runs, its last words once it ends", () => {
  const stretch = (steps: number) =>
    item({ kind: "tool", payload: { label: "Setting direction", steps, artboards: ["ab_1"] } });
  const ask = message(bryce, "Build it");
  const copied = reply("Copied the layout.");
  const done = reply("Done.");
  const items = [ask, stretch(2), copied, stretch(3), stretch(11), done];
  // While it runs: no stretch lines, whatever their labels; what it went on after is an aside.
  expect(lines(threadRows(items, working))).toEqual(["message", "aside", "assistant"]);
  expect(ids(threadRows(items, idle))).toEqual([ask.id, done.id]);
  // It stopped mid-work: nothing is its answer, and the stop is its last line.
  const stop = item({ kind: "notice", payload: { type: "stopped", by: bryce } });
  expect(ids(threadRows([...items.slice(0, 4), stop], idle))).toEqual([ask.id, stop.id]);
  // Work after its last words and nothing said of how it ended: those words stay.
  expect(ids(threadRows(items.slice(0, 4), idle))).toEqual([ask.id, copied.id]);
});

test("earlier turns keep only their answers while a later one runs; a person mid-turn stays", () => {
  const firstAnswer = reply("First.");
  const before = reply("On the way.");
  const one = [
    message(bryce),
    turnItem(
      {
        ended: "done",
        final: firstAnswer.id,
        log: [{ after: before.id, text: "Drew x", count: 1 }],
      },
      false,
    ),
    before,
    firstAnswer,
  ];
  const two = [
    message(bryce),
    turnItem({}, true),
    reply("Working."),
    message(maya),
    reply("Taking that in."),
  ];
  expect(lines(threadRows([...one, ...two], working))).toEqual([
    "message",
    "assistant",
    "message",
    "aside",
    "message",
    "assistant",
  ]);
});

test("rows: no line for the run starting", () => {
  const items = [
    item({ kind: "notice", payload: { type: "started" } }),
    message(bryce),
    reply("Done."),
  ];
  expect(lines(threadRows(items))).toEqual(["message", "assistant"]);
});

test("avatars stamp each person's run only once more than one person is here", () => {
  const solo = threadRows([message(bryce), message(bryce), reply("ok")]) as ThreadRow[];
  expect(solo.map((r) => [r.continues, r.avatar])).toEqual([
    [false, false],
    [true, false],
    [false, false],
  ]);
  const team = threadRows([
    message(bryce),
    message(bryce),
    message(maya),
    reply("ok"),
  ]) as ThreadRow[];
  expect(team.map((r) => [r.continues, r.avatar])).toEqual([
    [false, false],
    [true, true],
    [false, true],
    [false, false],
  ]);
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
  // While the owner's plan is at its limit nothing sends, but a run still going can be stopped.
  const gate = { kind: "claude_limit", owner: bryce, until: "2026-11-10T21:00:00Z" } as const;
  expect(composerButton({ ...base, text: "hello", gate })).toBe("waiting");
  expect(composerButton({ ...base, working: true, gate })).toBe("stop");
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

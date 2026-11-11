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
import {
  isFold,
  type Row,
  SENT_GRACE_MS,
  type ThreadRow,
  threadRows,
  workingLine,
} from "./thread.ts";

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
const lines = (rows: Row[]) =>
  rows.map((r) => (isFold(r) ? `fold: ${r.fold.summary}` : `${r.item.kind}`));

test("the working line: the agent's state while it works, never blank, gone once the turn folds", () => {
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
});

test("a running turn shows its messages and none of its work; it folds once it ends", () => {
  const ask = message(bryce, "Two boards and a file");
  const first = reply("Drawing them.");
  const second = reply("Now the file.");
  const final = reply("Done: two boards and the token file.");
  const log = [
    { after: null, text: "Read the canvas", count: 1 },
    { after: first.id, text: 'Drew "Hero"', count: 2 },
    { after: second.id, text: "Edited styles/tokens.css", count: 1 },
  ];
  const running = turnItem({ log }, true);
  const live = [ask, running, first, second, final];
  expect(lines(threadRows(live, working))).toEqual([
    "message",
    "assistant",
    "assistant",
    "assistant",
  ]);
  const done = turnItem(
    { ended: "done", ms: 125_000, final: final.id, boards: 2, files: 1, log },
    false,
  );
  const rows = threadRows([ask, { ...done, id: running.id }, first, second, final], working);
  expect(lines(rows)).toEqual([
    "message",
    "fold: Worked for 2 min · 2 boards · 1 file",
    "assistant",
  ]);
  const fold = rows.find(isFold)!.fold;
  expect(
    fold.parts.map((p) =>
      p.kind === "steps" ? p.steps.map((s) => `${s.text} ×${s.count}`).join(", ") : p.item.id,
    ),
  ).toEqual([
    "Read the canvas ×1",
    first.id,
    'Drew "Hero" ×2',
    second.id,
    "Edited styles/tokens.css ×1",
  ]);
  // The answer stays in full: it is the line after the fold.
  expect((rows.at(-1) as { item: ThreadItem }).item.id).toBe(final.id);
});

test("a single reply has no fold; a stopped or failed turn folds with its ending outside", () => {
  const ask = message(bryce);
  const only = reply("Sure.");
  expect(
    lines(threadRows([ask, turnItem({ ended: "done", final: only.id }, false), only])),
  ).toEqual(["message", "assistant"]);
  const said = reply("Starting.");
  const stopped = [
    ask,
    turnItem(
      { ended: "stopped", ms: 40_000, log: [{ after: said.id, text: "Read comments", count: 3 }] },
      false,
    ),
    said,
    item({ kind: "notice", payload: { type: "stopped", by: bryce } }),
  ];
  expect(lines(threadRows(stopped))).toEqual([
    "message",
    "fold: Worked for 40 s · 4 steps",
    "notice",
  ]);
  const failed = [
    ask,
    turnItem(
      {
        ended: "failed",
        ms: 3_000,
        files: 1,
        log: [{ after: null, text: "Edited a.ts", count: 1 }],
      },
      false,
    ),
    item({
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: "Overloaded" },
    }),
  ];
  expect(lines(threadRows(failed))).toEqual(["message", "fold: Worked for 3 s · 1 file", "notice"]);
});

test("a turn that ends on a question keeps it outside the fold; one asked on the way folds", () => {
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
  expect(lines(rows)).toEqual([
    "message",
    "fold: Worked for a moment · 4 steps",
    "assistant",
    "notice",
  ]);
  expect(rows.find(isFold)!.fold.parts.map((p) => p.kind)).toEqual(["message", "steps", "asked"]);
});

test("an older runner's thread folds the same way, its stretches counted, its stale labels dropped", () => {
  const at = (s: number) =>
    `2026-11-10T16:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}Z`;
  const old = (content: Omit<ThreadItem, "id" | "seq" | "at" | "streaming">, s: number) =>
    ({ ...item(content), at: at(s) }) as ThreadItem;
  const stretch = (s: number, steps: number, artboards: string[]) =>
    old({ kind: "tool", payload: { label: "Setting direction", steps, artboards } }, s);
  const items = [
    old({ kind: "message", payload: { text: "Build it", from: bryce, attachments: [] } }, 0),
    stretch(1, 2, ["ab_1"]),
    old({ kind: "assistant", payload: { text: "Copied the layout." } }, 20),
    stretch(21, 3, ["ab_2"]),
    stretch(40, 11, ["ab_2", "ab_3"]),
    old({ kind: "assistant", payload: { text: "Done." } }, 130),
  ];
  // While it runs: no stretch lines, whatever their labels.
  expect(lines(threadRows(items, working))).toEqual(["message", "assistant", "assistant"]);
  const rows = threadRows(items, idle);
  expect(lines(rows)).toEqual(["message", "fold: Worked for 2 min · 3 boards", "assistant"]);
  const steps = rows.find(isFold)!.fold.parts.flatMap((p) => (p.kind === "steps" ? p.steps : []));
  expect(steps.map((s) => s.text)).toEqual(["2 steps", "3 steps", "11 steps"]);
  // A stretch after the last message: the turn stopped mid-work, and nothing is its answer.
  const cut = threadRows([...items.slice(0, 4)], idle);
  expect(lines(cut)).toEqual(["message", "fold: Worked for 20 s · 2 boards"]);
});

test("earlier turns are folded while a later one runs; a person mid-turn stays in place", () => {
  const one = [
    message(bryce),
    turnItem({ ended: "done", log: [{ after: null, text: "Drew x", count: 1 }] }, false),
  ];
  const firstAnswer = reply("First.");
  (one[1]!.payload as { turn: TurnRecord }).turn.final = firstAnswer.id;
  const two = [
    message(bryce),
    turnItem({}, true),
    reply("Working."),
    message(maya),
    reply("Taking that in."),
  ];
  expect(lines(threadRows([...one, firstAnswer, ...two], working))).toEqual([
    "message",
    "fold: Worked for a moment · 4 steps",
    "assistant",
    "message",
    "assistant",
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

test("drafts are kept per person and design, and signing out clears them", () => {
  writeDraft("bryce", "dsn_hero", "Calmer, and keep the green");
  writeDraft("maya", "dsn_hero", "Try the serif smaller");
  expect(readDraft("bryce", "dsn_hero")).toBe("Calmer, and keep the green");
  // Someone else signed in on the same Mac sees their own draft, not yours.
  expect(readDraft("maya", "dsn_hero")).toBe("Try the serif smaller");
  expect(readDraft("bryce", "dsn_other")).toBe("");
  clearDrafts();
  expect(readDraft("bryce", "dsn_hero")).toBe("");
  expect(readDraft("maya", "dsn_hero")).toBe("");
});

test("a message that failed to send comes back ahead of what was typed since", () => {
  expect(restoreDraft("Keep the green", "")).toBe("Keep the green");
  expect(restoreDraft("Keep the green", "  ")).toBe("Keep the green");
  expect(restoreDraft("Keep the green", "and the photo")).toBe("Keep the green\nand the photo");
});

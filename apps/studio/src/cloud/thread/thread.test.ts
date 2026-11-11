import { expect, test } from "bun:test";
import type { AgentActivity, Person, ThreadItem } from "../model.ts";
import { composerButton } from "./composer-rules.ts";
import { FOLLOWING, type Follow, follow } from "./follow.ts";
import { threadRows, workingLine } from "./thread.ts";

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
const work = (label: string, streaming: boolean) =>
  item({ kind: "tool", payload: { label, steps: 3, artboards: [] } }, streaming);

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

test("the working line is the newest work, or the run's status, only while working", () => {
  const items = [message(bryce), reply("On it."), work("Drawing Hero · B", true)];
  expect(workingLine(items, working)).toBe("Drawing Hero · B");
  expect(workingLine(items, idle)).toBeNull();
  // A person's message mid-run doesn't hide what the agent is doing.
  expect(workingLine([...items, message(maya)], working)).toBe("Drawing Hero · B");
  // Text being written says it for itself.
  expect(workingLine([...items, reply("Folding", true)], working)).toBeNull();
  expect(workingLine([message(bryce)], working)).toBe("Working on it");
  expect(workingLine([message(bryce)], { state: "working", status: null })).toBe("Working…");
  expect(workingLine([message(bryce)], { state: "waking", status: null })).toBe("Waking up…");
  // The question is in the composer while it waits; no working line.
  expect(workingLine(items, { state: "needs_you", status: null })).toBeNull();
});

test("rows: no line for the run starting or for work still going; finished work folds", () => {
  const items = [
    item({ kind: "notice", payload: { type: "started" } }),
    message(bryce),
    work("Reading the repo", false),
    reply("Done."),
    work("Drawing", true),
  ];
  expect(threadRows(items).map((r) => r.item.kind)).toEqual(["message", "tool", "assistant"]);
});

test("avatars stamp each person's run only once more than one person is here", () => {
  const solo = threadRows([message(bryce), message(bryce), reply("ok")]);
  expect(solo.map((r) => [r.continues, r.avatar])).toEqual([
    [false, false],
    [true, false],
    [false, false],
  ]);
  const team = threadRows([message(bryce), message(bryce), message(maya), reply("ok")]);
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

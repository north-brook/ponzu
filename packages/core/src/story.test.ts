import { describe, expect, test } from "bun:test";
import { emptyDoc, type Op } from "./doc.ts";
import { checkpointLine, type JournalEntry, opLine, parseJournal } from "./journal.ts";
import { chooseStory, type Look, type Moment, moments, SHOT, shotAt, timeline } from "./story.ts";
import type { Thread } from "./types.ts";

const agent = { kind: "agent" as const, name: "Claude", client: "claude" };
const user = { kind: "user" as const, name: "Bryce" };
const T0 = 1_700_000_000_000;
const el = (id: string) => ({
  kind: "el" as const,
  id,
  tag: "div",
  attrs: {},
  style: {},
  children: [],
});
const board = (id: string) => ({
  op: "artboard.create" as const,
  page: "pg",
  index: 0,
  artboard: {
    id,
    name: id,
    x: 0,
    y: 0,
    root: {
      kind: "el" as const,
      id,
      tag: "section",
      attrs: {},
      style: { width: "800px", height: "600px" },
      children: [],
    },
  },
});
const comment = (id: string, ab: string, text = "Make it bolder please"): Op => ({
  op: "thread.create",
  thread: {
    id,
    artboardId: ab,
    x: 1,
    y: 1,
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    messages: [{ id: `m${id}`, author: user, text, createdAt: 0 }],
  } satisfies Thread,
});

function journal(steps: [number, Op, typeof agent | typeof user, string[]][]): JournalEntry[] {
  const d = emptyDoc("F");
  d.pages.push({ id: "pg", name: "Home", artboards: [] });
  let text = checkpointLine(d, T0);
  for (const [dt, op, who, abs] of steps) text += opLine(op, who, abs, T0 + dt);
  return parseJournal(text);
}

/** Build a, build b, you comment on a twice and b once, the agent fixes a then b, resolves. */
function session() {
  return journal([
    [1000, board("a"), agent, ["a"]],
    [2000, { op: "insert", parent: "a", index: 0, nodes: [el("a1")] }, agent, ["a"]],
    [3000, board("b"), agent, ["b"]],
    [4000, { op: "insert", parent: "b", index: 0, nodes: [el("b1")] }, agent, ["b"]],
    [5000, { op: "insert", parent: "a", index: 1, nodes: [el("a2")] }, agent, ["a"]],
    [60_000, comment("t1", "a"), user, []],
    [62_000, comment("t2", "a"), user, []],
    [64_000, comment("t3", "b"), user, []],
    [90_000, { op: "style", id: "a1", style: { color: "red" } }, agent, ["a"]],
    [91_000, { op: "thread.update", id: "t1", status: "resolved" }, agent, []],
    [92_000, { op: "style", id: "b1", style: { color: "red" } }, agent, ["b"]],
    [93_000, { op: "thread.update", id: "t3", status: "resolved" }, agent, []],
  ]);
}

describe("story", () => {
  test("the session is a few moments: per-board work, then your turn, then the work it asked for", () => {
    const ms = moments(session());
    expect(ms.map((m) => (m.kind === "work" ? `work:${m.board}` : m.kind))).toEqual([
      "work:a",
      "work:b",
      "turn",
      "work:a",
      "work:b",
    ]);
    const [a1, , turnM, a2, b2] = ms as Extract<Moment, { kind: "work" }>[];
    const turn = turnM as unknown as Moment;
    // Board a's build-up is one moment, with all three of its ops, though b's work came between.
    expect(a1!.ops).toBe(3);
    expect(turn!.kind === "turn" && turn!.comments.map((c) => c.thread)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(a2!.answers).toBe(0);
    expect(a2!.resolves).toEqual(["t1"]);
    expect(b2!.resolves).toEqual(["t3"]);
  });

  test("a short film is one turn and its payoff; tiny changes don't make the cut", () => {
    const ms = moments(session());
    const looks = new Map<Moment, Look>(ms.map((m) => [m, { change: 0.3 }]));
    const work = ms.filter((m) => m.kind === "work");
    looks.set(work[1]!, { change: 0.01 });
    const story = chooseStory(ms, looks, { length: 15 });
    const turn = story.find((m) => m.kind === "turn");
    expect(turn).toBeDefined();
    // Its cards go to the comments the film pays off: the one on board a.
    expect(turn!.kind === "turn" && turn!.featured).toEqual(["t1", "t2"]);
    expect(story.filter((m) => m.kind === "work" && m.answers === 0)).toHaveLength(1);
    expect(story).not.toContain(work[1]!);
  });

  test("the timeline is exactly the length, and nothing changes while the camera travels", () => {
    const ms = moments(session());
    const looks = new Map<Moment, Look>(ms.map((m) => [m, { change: 0.3 }]));
    for (const length of [15, 30, 60]) {
      const tl = timeline(chooseStory(ms, looks, { length }), { length });
      expect(tl.duration).toBeCloseTo(length, 5);
      for (const s of tl.shots) {
        expect(s.arrive).toBeLessThanOrEqual(s.change + 1e-9);
        expect(s.change).toBeLessThanOrEqual(s.changed + 1e-9);
        expect(shotAt(tl, (s.start + s.arrive) / 2).phase).toBe(
          s.start < s.arrive ? "travel" : shotAt(tl, s.start).phase,
        );
      }
      // Comments in a short film: two cards, the rest pins.
      const turn = tl.shots.find((s) => s.moment.kind === "turn");
      if (length === 15) expect(turn!.landings!.filter((l) => l.card)).toHaveLength(2);
      expect(tl.endCard).toBeCloseTo(length - SHOT.end, 5);
    }
  });
});

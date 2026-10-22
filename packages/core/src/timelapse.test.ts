import { describe, expect, test } from "bun:test";
import { emptyDoc, type Op } from "./doc.ts";
import type { JournalEntry } from "./journal.ts";
import { checkpointLine, docAt, latestDoc, opLine, parseJournal } from "./journal.ts";
import {
  bezier,
  cameraAt,
  END_CARD,
  frameFocus,
  framingFor,
  groupTurns,
  lastSession,
  planFilm,
  planShots,
} from "./timelapse.ts";
import type { Thread } from "./types.ts";

const agent = { kind: "agent" as const, name: "Claude", client: "claude" };
const user = { kind: "user" as const, name: "Bryce" };
const T0 = 1_700_000_000_000;

function seedDoc() {
  const d = emptyDoc("Fern");
  d.pages.push({ id: "pg", name: "Home", artboards: [] });
  return d;
}

function artboard(id: string, x: number) {
  return {
    op: "artboard.create" as const,
    page: "pg",
    index: 0,
    artboard: {
      id,
      name: id,
      x,
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
  };
}

function thread(id: string, artboardId: string): Thread {
  return {
    id,
    artboardId,
    x: 10,
    y: 10,
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    messages: [{ id: `m_${id}`, author: user, text: "Tighter?", createdAt: 0 }],
  };
}

/** A journal built line by line, as the writer would. */
function journal(steps: [number, Op, typeof agent | typeof user, string[]][]): JournalEntry[] {
  let text = checkpointLine(seedDoc(), T0);
  for (const [dt, op, who, abs] of steps) text += opLine(op, who, abs, T0 + dt);
  return parseJournal(text);
}

const el = (id: string) => ({
  kind: "el" as const,
  id,
  tag: "div",
  attrs: {},
  style: {},
  children: [],
});

function session() {
  return journal([
    [1000, artboard("ab_a", 0), agent, ["ab_a"]],
    [3000, { op: "insert", parent: "ab_a", index: 0, nodes: [el("n1")] }, agent, ["ab_a"]],
    [5000, { op: "insert", parent: "ab_a", index: 1, nodes: [el("n2")] }, agent, ["ab_a"]],
    [9000, artboard("ab_b", 1000), agent, ["ab_b"]],
    [600_000, { op: "thread.create", thread: thread("t1", "ab_a") }, user, ["ab_a"]],
    [604_000, { op: "thread.create", thread: thread("t2", "ab_b") }, user, ["ab_b"]],
    [700_000, { op: "style", id: "n1", style: { color: "red" } }, agent, ["ab_a"]],
    [701_000, { op: "thread.update", id: "t1", status: "resolved" }, agent, []],
    [705_000, { op: "insert", parent: "ab_b", index: 0, nodes: [el("n3")] }, agent, ["ab_b"]],
    [706_000, { op: "thread.update", id: "t2", status: "resolved" }, agent, []],
  ]);
}

describe("journal", () => {
  test("ignores a partial last line and replays to any time", () => {
    const text = `${checkpointLine(seedDoc(), T0)}${opLine(artboard("ab_a", 0), agent, ["ab_a"], T0 + 5)}{"v":1,"t":`;
    const entries = parseJournal(text);
    expect(entries).toHaveLength(2);
    expect(docAt(entries, T0)!.pages[0]!.artboards).toHaveLength(0);
    expect(latestDoc(entries)!.pages[0]!.artboards[0]!.id).toBe("ab_a");
    expect(docAt(entries, T0 - 1)).toBeNull();
  });

  test("ops that no longer fit are skipped, and a later checkpoint wins", () => {
    const later = seedDoc();
    later.name = "Renamed";
    const text =
      checkpointLine(seedDoc(), T0) +
      opLine({ op: "remove", id: "nope" }, agent, [], T0 + 1) +
      checkpointLine(later, T0 + 2);
    expect(latestDoc(parseJournal(text))!.name).toBe("Renamed");
  });

  test("origin keeps kind, name and the agent's product", () => {
    const [, e] = parseJournal(
      checkpointLine(seedDoc(), T0) + opLine(artboard("a", 0), agent, ["a"], T0),
    );
    expect(e!.kind === "op" && e!.origin).toEqual({
      kind: "agent",
      name: "Claude",
      client: "claude",
    });
  });
});

describe("plan", () => {
  test("the last session starts after the last hour-long gap", () => {
    const e = journal([
      [0, artboard("a", 0), agent, ["a"]],
      [2 * 3600_000, artboard("b", 900), agent, ["b"]],
      [
        2 * 3600_000 + 5000,
        { op: "insert", parent: "b", index: 0, nodes: [el("x")] },
        agent,
        ["b"],
      ],
    ]);
    expect(lastSession(e)).toEqual({ from: T0 + 2 * 3600_000, to: T0 + 2 * 3600_000 + 5000 });
  });

  test("consecutive user comments make one turn; agent work between makes the next", () => {
    expect(
      groupTurns(["edit", "edit", "comment", "comment", "edit", "resolve", "comment"]),
    ).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });

  test("length is the output: idle is cut, comments get about a second, edits share the rest", () => {
    for (const length of [15, 30, 60]) {
      const plan = planFilm(session(), { length });
      expect(plan.duration).toBeCloseTo(length, 5);
      expect(plan.endCard).toBeCloseTo(length - END_CARD, 5);
      const comments = plan.beats.filter((b) => b.kind === "comment");
      expect(comments).toHaveLength(2);
      for (const c of comments) expect(c.end - c.start).toBeCloseTo(1, 1);
      // The ten-minute idle gap doesn't swallow the film.
      const edits = plan.beats.filter((b) => b.kind === "edit");
      const longest = Math.max(...edits.map((b) => b.end - b.start));
      expect(longest).toBeLessThan(length * 0.35);
      // Beats run back to back, in order.
      for (let i = 1; i < plan.beats.length; i++)
        expect(plan.beats[i]!.start).toBeCloseTo(plan.beats[i - 1]!.end, 6);
    }
  });

  test("turns alternate agent, you, agent", () => {
    const plan = planFilm(session(), { length: 30 });
    expect(plan.turns.map((t) => t.kind)).toEqual(["agent", "user", "agent"]);
    expect(plan.turns[2]!.who).toEqual({ name: "Claude", client: "claude" });
  });

  test("trims restrict the range", () => {
    const e = session();
    const plan = planFilm(e, { length: 15, range: { from: T0 + 600_000, to: T0 + 800_000 } });
    expect(plan.beats[0]!.kind).toBe("comment");
    expect(plan.beats).toHaveLength(6);
    expect(plan.duration).toBeCloseTo(15, 5);
    // The opening frame already has the boards made before the range.
    expect(docAt(e, e[plan.base]!.t)!.pages[0]!.artboards).toHaveLength(2);
  });

  test("many comments in a short film still fit", () => {
    const steps: [number, Op, typeof agent | typeof user, string[]][] = [
      [0, artboard("a", 0), agent, ["a"]],
    ];
    for (let i = 0; i < 30; i++)
      steps.push([
        1000 + i * 1000,
        { op: "thread.create", thread: thread(`t${i}`, "a") },
        user,
        ["a"],
      ]);
    const plan = planFilm(journal(steps), { length: 15 });
    expect(plan.duration).toBeCloseTo(15, 5);
    expect(plan.beats.at(-1)!.end).toBeLessThanOrEqual(plan.endCard + 1e-6);
  });
});

describe("camera", () => {
  test("easing matches cubic-bezier endpoints and is monotonic", () => {
    const f = bezier(0.65, 0, 0.35, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(0.5)).toBeCloseTo(0.5, 3);
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.01) {
      expect(f(x)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f(x);
    }
  });

  test("the same board frames whole in 16:9 and tighter, inside it, in 9:16", () => {
    const board = { x: 0, y: 0, w: 1440, h: 900 };
    const wide = frameFocus({ page: "p", board }, { w: 1920, h: 1080 }, framingFor("16:9"));
    expect(wide.cx).toBe(720);
    expect(wide.zoom).toBeLessThan(1.1);
    const tall = frameFocus(
      { page: "p", board, detail: { x: 1200, y: 100, w: 200, h: 100 } },
      { w: 1080, h: 1920 },
      framingFor("9:16"),
    );
    expect(tall.zoom).toBeGreaterThanOrEqual(framingFor("9:16").minZoom);
    // Panned toward the detail, but the frame stays within the board (plus padding).
    expect(tall.cx).toBeGreaterThan(720);
    expect(tall.cx + 1080 / tall.zoom / 2).toBeLessThanOrEqual(1440 + 56 / tall.zoom + 1e-6);
  });

  test("the camera moves smoothly, arriving as each beat lands", () => {
    const plan = planFilm(session(), { length: 30 });
    const view = { w: 1920, h: 1080 };
    const boards: Record<string, { x: number; y: number; w: number; h: number }> = {
      ab_a: { x: 0, y: 0, w: 800, h: 600 },
      ab_b: { x: 1000, y: 0, w: 800, h: 600 },
    };
    const focus = plan.beats.map((b) => {
      const id = b.artboards[0];
      return id ? { page: "pg", board: boards[id]! } : null;
    });
    const shots = planShots(plan, focus, view, framingFor("16:9"), {
      page: "pg",
      board: { x: 0, y: 0, w: 1800, h: 600 },
    });
    expect(shots.length).toBeGreaterThan(2);
    let prev = cameraAt(shots, 0, view)!;
    for (let f = 0; f <= plan.duration; f += 1 / 30) {
      const c = cameraAt(shots, f, view)!;
      expect(Number.isFinite(c.cx) && Number.isFinite(c.zoom)).toBe(true);
      // No jumps: under a third of a screen per frame.
      expect(Math.abs(c.cx - prev.cx) * c.zoom).toBeLessThan(view.w / 3);
      prev = c;
    }
    for (const s of shots.slice(1)) {
      const c = cameraAt(shots, s.arrive, view)!;
      expect(c.cx).toBeCloseTo(s.cam.cx, 0);
    }
  });
});

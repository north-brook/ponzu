import { describe, expect, test } from "bun:test";
import { emptyDoc, type Op } from "./doc.ts";
import type { JournalEntry } from "./journal.ts";
import { checkpointLine, docAt, latestDoc, opLine, parseJournal } from "./journal.ts";
import {
  avoidCuts,
  bezier,
  cutLines,
  frameFocus,
  framingFor,
  lastSession,
  streamUnits,
} from "./timelapse.ts";

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
    const wide = frameFocus({ page: "p", board }, { w: 960, h: 540 }, framingFor("16:9"));
    expect(wide.cx).toBe(720);
    expect(wide.zoom).toBeLessThan(1);
    const f = framingFor("9:16");
    const tall = frameFocus(
      { page: "p", board, detail: { x: 1200, y: 100, w: 200, h: 100 } },
      { w: 540, h: 960 },
      f,
    );
    expect(tall.zoom).toBeGreaterThanOrEqual(f.minZoom);
    // Panned toward the detail, but the frame stays within the board (plus padding).
    expect(tall.cx).toBeGreaterThan(720);
    expect(tall.cx + 540 / tall.zoom / 2).toBeLessThanOrEqual(1440 + f.pad / tall.zoom + 1e-6);
  });
});

describe("stream-in", () => {
  test("one big section opens into its blocks", () => {
    const tree = {
      kind: "el",
      id: "s",
      children: [
        { kind: "el", id: "h", children: [] },
        { kind: "text" },
        {
          kind: "el",
          id: "grid",
          children: [1, 2, 3, 4].map((i) => ({ kind: "el", id: `c${i}`, children: [] })),
        },
      ],
    };
    const all = new Map<string, typeof tree>();
    const index = (n: { id?: string; children?: unknown[] }) => {
      if (n.id) all.set(n.id, n as typeof tree);
      for (const c of (n.children ?? []) as { id?: string }[]) index(c);
    };
    index(tree);
    expect(streamUnits((id) => all.get(id) ?? null, ["s"])).toEqual(["h", "c1", "c2", "c3", "c4"]);
  });
});

describe("framing never cuts text", () => {
  test("a frame edge across a line moves to a gap", () => {
    const view = { w: 540, h: 960 };
    const f = framingFor("9:16");
    // A long heading spanning the board, and the frame centred on its right half.
    const texts = [
      { x: 0, y: 100, w: 1000, h: 40 },
      { x: 600, y: 300, w: 300, h: 20 },
    ];
    const cam = { page: "p", cx: 800, cy: 400, zoom: 1 };
    const fixed = avoidCuts(cam, texts, view, f);
    const x0 = fixed.cx - view.w / 2 / fixed.zoom;
    const x1 = fixed.cx + view.w / 2 / fixed.zoom;
    // The 1000px heading is too wide at zoom 1, so it pulls back to fit it whole.
    expect(fixed.zoom).toBeLessThan(1);
    for (const r of texts) {
      expect(r.x >= x0 - 1e-6 || r.x + r.w <= x0 + 1e-6).toBe(true);
      expect(r.x + r.w <= x1 + 1e-6 || r.x >= x1 - 1e-6).toBe(true);
    }
    // A line under the top edge moves fully in or out.
    const top = avoidCuts(
      { page: "p", cx: 800, cy: 560, zoom: 1 },
      [{ x: 700, y: 70, w: 100, h: 40 }],
      view,
      f,
    );
    const y0 = top.cy - view.h / 2 + (f.top + 8);
    expect(70 >= y0 - 1e-6 || 110 <= y0 + 1e-6).toBe(true);
  });
});

describe("cut lines", () => {
  test("a line across an edge, or under the wayfinding line, is cut; one wholly in or out isn't", () => {
    const view = { w: 960, h: 540 };
    const f = { ...framingFor("16:9"), pill: { x: 14, y: 14, w: 200, h: 30 } };
    const cam = { page: "p", cx: 480, cy: 270, zoom: 1 };
    const inside = { x: 400, y: 200, w: 100, h: 20 };
    const across = { x: 900, y: 200, w: 100, h: 20 };
    const outside = { x: 1200, y: 200, w: 100, h: 20 };
    const underPill = { x: 20, y: 20, w: 60, h: 14 };
    expect(cutLines(cam, [inside, across, outside, underPill], view, f)).toEqual([
      across,
      underPill,
    ]);
    // A frame found for a cut line keeps it whole.
    const fixed = avoidCuts(cam, [across], view, f);
    expect(cutLines(fixed, [across], view, f)).toEqual([]);
  });
});

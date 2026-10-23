import { describe, expect, test } from "bun:test";
import type { Doc, JournalEntry, Op, PNode } from "@ponzu/core";
import { buildReel } from "./reel.ts";

// Boards here have fixed heights, so a reel is planned without laying anything out.
const agent = { kind: "agent" as const, name: "Claude" };
const person = { kind: "user" as const, name: "You" };

const el = (id: string, children: PNode[] = [], style: Record<string, string> = {}): PNode => ({
  kind: "el",
  id,
  tag: "div",
  attrs: {},
  style,
  children,
});
const text = (value: string): PNode => ({ kind: "text", value });

function board(id: string, x = 0): Op {
  return {
    op: "artboard.create",
    page: "pg_a",
    index: 0,
    artboard: {
      id,
      name: id,
      x,
      y: 0,
      root: {
        kind: "el",
        id: `${id}_root`,
        tag: "section",
        attrs: {},
        style: { width: "400px", height: "300px" },
        children: [],
      },
    },
  };
}

function journal(...steps: { op: Op; who?: "agent" | "person" }[]): JournalEntry[] {
  const doc: Doc = {
    name: "Test",
    pages: [{ id: "pg_a", name: "Home", artboards: [] }],
    tokens: "",
    threads: [],
    notes: {},
  };
  let t = 1_000;
  return [
    { v: 1, t, kind: "checkpoint", doc },
    ...steps.map(({ op, who }): JournalEntry => {
      t += 1_000;
      const artboards =
        op.op === "artboard.create"
          ? [op.artboard.id]
          : op.op === "insert" || op.op === "style"
            ? ["ab_one"]
            : [];
      return {
        v: 1,
        t,
        kind: "op",
        op,
        origin: who === "person" ? person : agent,
        artboards,
      };
    }),
  ];
}

const insert = (parent: string, nodes: PNode[]): Op => ({ op: "insert", parent, index: 0, nodes });

describe("reel", () => {
  test("a stretch that only edits a screen already there films that screen", async () => {
    const before = journal(
      { op: board("ab_one") },
      { op: insert("ab_one_root", [el("n_card", [el("n_title", [text("Hello")])])]) },
    );
    // The film covers only what came after: a restyle of a card that was already there.
    const later: JournalEntry[] = [
      ...before,
      {
        v: 1,
        t: 60_000,
        kind: "op",
        op: { op: "style", id: "n_card", style: { background: "red" } },
        origin: agent,
        artboards: ["ab_one"],
      },
    ];
    const reel = await buildReel({
      name: "Test",
      entries: later,
      shape: "16:9",
      range: { from: 50_000, to: 70_000 },
      theme: "light",
    });
    expect([...reel.boards.keys()]).toEqual(["ab_one"]);
  });

  test("nothing made or changed in the stretch says so rather than crashing", async () => {
    await expect(
      buildReel({
        name: "Test",
        entries: journal({ op: board("ab_one") }),
        shape: "16:9",
        range: { from: 90_000, to: 99_000 },
        theme: "light",
      }),
    ).rejects.toThrow("Nothing was made or changed");
  });

  test("a checkpoint inside the stretch is the canvas from then on", async () => {
    const entries = journal({ op: board("ab_one") });
    // The folder changed outside ops: a checkpoint brings a board the ops never made.
    const reset = structuredClone(
      (entries[0] as Extract<JournalEntry, { kind: "checkpoint" }>).doc,
    );
    reset.pages[0]!.artboards.push({
      id: "ab_two",
      name: "ab_two",
      x: 500,
      y: 0,
      root: {
        kind: "el",
        id: "ab_two_root",
        tag: "section",
        attrs: {},
        style: { width: "400px", height: "300px" },
        children: [],
      },
    });
    entries.push(
      { v: 1, t: 5_000, kind: "checkpoint", doc: reset },
      {
        v: 1,
        t: 6_000,
        kind: "op",
        op: insert("ab_two_root", [el("n_x", [text("After the reset")])]),
        origin: agent,
        artboards: ["ab_two"],
      },
    );
    const reel = await buildReel({ name: "Test", entries, shape: "16:9", theme: "light" });
    expect(reel.boards.has("ab_two")).toBe(true);
  });

  test("a container restyled after a comment is a revision of its own", async () => {
    const entries: JournalEntry[] = [
      ...journal(
        { op: board("ab_one") },
        { op: insert("ab_one_root", [el("n_card", [el("n_title", [text("Hello")])])]) },
      ),
      {
        v: 1,
        t: 10_000,
        kind: "op",
        op: {
          op: "thread.create",
          thread: {
            id: "th_1",
            artboardId: "ab_one",
            x: 10,
            y: 10,
            status: "open",
            createdAt: 10_000,
            updatedAt: 10_000,
            messages: [{ id: "m1", author: person, text: "Make the card red.", createdAt: 10_000 }],
          },
        },
        origin: person,
        artboards: ["ab_one"],
      },
      {
        v: 1,
        t: 11_000,
        kind: "op",
        op: { op: "style", id: "n_card", style: { background: "red" } },
        origin: agent,
        artboards: ["ab_one"],
      },
    ];
    const reel = await buildReel({ name: "Test", entries, shape: "16:9", theme: "light" });
    const rev = reel.revisions.get("ab_one");
    expect(rev?.recolor).toBe(true);
    expect(reel.segments.some((s) => s.kind === "revise")).toBe(true);
    expect(reel.comments.map((c) => c.thread)).toEqual(["th_1"]);
  });
});

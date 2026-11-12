import { describe, expect, test } from "bun:test";
import type { CanvasListRow, QuestionRow } from "@ponzu/client";
import { keepUnchanged } from "@ponzu/client/model";
import {
  askLine,
  buildList,
  firstQuestion,
  indicatorOf,
  type ListContext,
  previewUri,
  previewWatch,
  QUESTION_ROWS,
  questionWatch,
  rowLabel,
} from "./list";

let n = 0;
function row(over: Partial<CanvasListRow> = {}): CanvasListRow {
  n += 1;
  return {
    id: `cnv_${n}`,
    workspaceId: "ws_1",
    repoId: "repo_1",
    repoFullName: "acme/site",
    ownerId: null,
    name: `Canvas ${n}`,
    icon: null,
    branch: "pz/pricing",
    status: "active",
    settledAt: null,
    seq: 1,
    previewSeq: null,
    agentState: "idle",
    agentStatus: null,
    agentBlocker: null,
    needsYouCount: 0,
    prNumber: null,
    prState: null,
    prChecks: "none",
    lastActivityAt: "2026-11-10T12:00:00.000Z",
    createdAt: "2026-11-01T12:00:00.000Z",
    seenSeq: 1,
    seenThreadSeq: null,
    assetKeyRotatedAt: null,
    ...over,
  };
}

const context = (over: Partial<ListContext> = {}): ListContext => ({
  kind: "org",
  people: new Map(),
  assetsUrls: new Map(),
  questions: new Map(),
  ...over,
});

function question(canvasId: string, seq: number, over: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: `q_${seq}`,
    canvasId,
    seq,
    status: "open",
    at: "2026-11-10T12:00:00.000Z",
    kind: "question",
    payload: {
      questions: [
        {
          header: `Header ${seq}`,
          question: `Which one, ${seq}?`,
          options: [{ label: "A", description: "" }],
          multiSelect: false,
        },
      ],
    },
    ...over,
  } as QuestionRow;
}

describe("the order", () => {
  const old = row({ name: "Old", lastActivityAt: "2026-11-01T00:00:00.000Z", needsYouCount: 1 });
  const fresh = row({ name: "Fresh", lastActivityAt: "2026-11-09T00:00:00.000Z" });
  const middle = row({ name: "Middle", lastActivityAt: "2026-11-05T00:00:00.000Z" });
  const names = (kind: "org" | "personal") =>
    buildList([fresh, old, middle], context({ kind })).active.map((r) => r.canvas.name);

  test("on a team, a canvas waiting on the viewer comes first, then newest activity", () => {
    expect(names("org")).toEqual(["Old", "Fresh", "Middle"]);
  });

  test("on a personal workspace, newest activity alone", () => {
    expect(names("personal")).toEqual(["Fresh", "Middle", "Old"]);
  });

  test("settled canvases go to the tray, most recently settled first, with no question", () => {
    const a = row({ name: "A", status: "settled", settledAt: "2026-11-02T00:00:00.000Z" });
    const b = row({ name: "B", status: "settled", settledAt: "2026-11-08T00:00:00.000Z" });
    const list = buildList([a, fresh, b], context());
    expect(list.active.map((r) => r.canvas.name)).toEqual(["Fresh"]);
    expect(list.settled.map((r) => r.canvas.name)).toEqual(["B", "A"]);
    expect(list.settled.every((r) => r.question === null)).toBe(true);
  });
});

describe("the indicator", () => {
  const summary = (over: Partial<CanvasListRow>) =>
    buildList([row(over)], context()).active[0]!.canvas;

  test("needs you outranks working, which outranks unseen", () => {
    expect(indicatorOf(summary({ needsYouCount: 2, agentState: "working", seq: 9 }))).toEqual({
      kind: "needs_you",
      count: 2,
    });
    expect(indicatorOf(summary({ agentState: "working", seq: 9 }))).toEqual({ kind: "working" });
    expect(indicatorOf(summary({ agentState: "waking" }))).toEqual({ kind: "working" });
    expect(indicatorOf(summary({ seq: 9, seenSeq: 3 }))).toEqual({ kind: "unseen" });
    expect(indicatorOf(summary({ seq: 3, seenSeq: 3 }))).toBeNull();
  });

  test("a canvas never opened counts as unseen once it has anything in it", () => {
    expect(indicatorOf(summary({ seq: 1, seenSeq: null }))).toEqual({ kind: "unseen" });
  });

  test("a settled row shows none", () => {
    const settled = buildList(
      [row({ status: "settled", settledAt: "2026-11-02T00:00:00.000Z", needsYouCount: 1 })],
      context(),
    ).settled[0]!.canvas;
    expect(indicatorOf(settled)).toBeNull();
  });
});

describe("previews", () => {
  test("a row with a preview and its canvas's files has one in each theme", () => {
    const r = row({ previewSeq: 42 });
    const canvas = buildList(
      [r],
      context({ assetsUrls: new Map([[r.id, "https://assets.test/k/"]]) }),
    ).active[0]!.canvas;
    expect(previewUri(canvas.preview, "light")).toBe("https://assets.test/k/previews/42-light.png");
    expect(previewUri(canvas.preview, "dark")).toBe("https://assets.test/k/previews/42-dark.png");
  });

  test("none until the canvas's files are known, and none without a preview", () => {
    const r = row({ previewSeq: 42 });
    expect(buildList([r], context()).active[0]!.canvas.preview).toBeNull();
    const without = row();
    const canvas = buildList(
      [without],
      context({ assetsUrls: new Map([[without.id, "https://assets.test/k/"]]) }),
    ).active[0]!.canvas;
    expect(previewUri(canvas.preview, "light")).toBeNull();
  });

  test("only canvases with a preview have their view asked for", () => {
    const a = row({ previewSeq: 3 });
    const b = row();
    expect(previewWatch([a, b])).toEqual([a.id]);
  });
});

describe("the question line", () => {
  test("a needs-you row says its first open question, oldest first", () => {
    const r = row({ needsYouCount: 2 });
    const list = buildList(
      [r],
      context({
        questions: new Map([
          [r.id, [question(r.id, 7), question(r.id, 4), question(r.id, 2, { status: "answered" })]],
        ]),
      }),
    );
    expect(list.active[0]!.question).toEqual({ header: "Header 4", text: "Which one, 4?" });
  });

  test("a row not waiting on the viewer has none, even with a question row about", () => {
    const r = row({ needsYouCount: 0 });
    const list = buildList([r], context({ questions: new Map([[r.id, [question(r.id, 1)]]]) }));
    expect(list.active[0]!.question).toBeNull();
  });

  test("before its questions arrive, a needs-you row has none", () => {
    expect(firstQuestion(undefined)).toBeNull();
    expect(firstQuestion([])).toBeNull();
  });

  test("each kind of ask is named as the Mac's strip names it", () => {
    const open = { id: "q", status: "open" as const, answeredBy: null };
    expect(askLine({ ...open, kind: "plan", plan: "1. Do it" })).toEqual({
      header: "Plan",
      text: "Approve the plan?",
    });
    expect(
      askLine({ ...open, kind: "permission", tool: "Bash", title: "Run npm", description: null }),
    ).toEqual({ header: "Permission", text: "Run npm" });
    expect(askLine({ ...open, kind: "secret", name: "STRIPE_KEY", description: null })).toEqual({
      header: "Secret",
      text: "STRIPE_KEY",
    });
    expect(
      askLine({ ...open, kind: "link", title: "Verify the domain", url: "x", description: null }),
    ).toEqual({ header: "Over to you", text: "Verify the domain" });
  });

  test(`questions are watched for at most ${QUESTION_ROWS} rows: the top needs-you ones`, () => {
    const waiting = Array.from({ length: 10 }, (_, i) =>
      row({
        needsYouCount: 1,
        lastActivityAt: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const quiet = row({ lastActivityAt: "2026-11-30T00:00:00.000Z" });
    const settled = row({ needsYouCount: 1, status: "settled" });
    const watched = questionWatch([quiet, settled, ...waiting], "org");
    expect(watched).toHaveLength(QUESTION_ROWS);
    // Newest first, as the list shows them; the quiet and settled rows are not watched.
    expect(watched).toEqual(
      waiting
        .toReversed()
        .slice(0, QUESTION_ROWS)
        .map((r) => r.id),
    );
  });
});

test("a live change to one row leaves the others the same objects, so only it draws again", () => {
  const a = row({ name: "A", lastActivityAt: "2026-11-09T00:00:00.000Z" });
  const b = row({ name: "B", lastActivityAt: "2026-11-05T00:00:00.000Z" });
  const before = buildList([a, b], context());
  // B moves to the top; A is untouched.
  const after = keepUnchanged(
    before,
    buildList([a, { ...b, lastActivityAt: "2026-11-10T00:00:00.000Z" }], context()),
  );
  expect(after.active.map((r) => r.canvas.name)).toEqual(["B", "A"]);
  expect(after.active[1]).toBe(before.active[0]!);
  expect(after.active[0]).not.toBe(before.active[1]!);
  expect(keepUnchanged(before, buildList([a, b], context()))).toBe(before);
});

test("VoiceOver hears the row as the Mac's label, with the question it waits on", () => {
  const r = row({ name: "Pricing", needsYouCount: 1, prNumber: 412, prState: "open" });
  const { canvas } = buildList([r], context()).active[0]!;
  expect(rowLabel(canvas, indicatorOf(canvas), { header: "Colour", text: "Which blue?" })).toBe(
    "Pricing, 1 waiting for you, site, pz/pricing, pull request #412, Colour: Which blue?",
  );
  const scratch = buildList([row({ name: "Poster", repoId: null, repoFullName: null })], context())
    .active[0]!.canvas;
  expect(rowLabel(scratch, null, null)).toBe("Poster, Scratch, Scratch");
});

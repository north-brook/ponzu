import { expect, test } from "bun:test";
import type { DesignSummary } from "./model.ts";
import { orderDesigns, railSignal, rowIndicator, settledShown } from "./status.ts";

const design = (over: Partial<DesignSummary> = {}): DesignSummary => ({
  id: "dsn",
  name: "A design",
  project: { kind: "scratch", city: "lisbon" },
  preview: null,
  status: "active",
  agentState: "idle",
  needsYou: 0,
  unseen: false,
  pullRequest: null,
  hereNow: [],
  owner: null,
  lastActivityAt: "2026-11-10T12:00:00.000Z",
  settledAt: null,
  ...over,
});

test("a row shows one indicator: needs you, then working, then unseen", () => {
  expect(rowIndicator(design())).toBeNull();
  expect(rowIndicator(design({ unseen: true }))).toEqual({ kind: "unseen" });
  expect(rowIndicator(design({ unseen: true, agentState: "working" }))).toEqual({
    kind: "working",
  });
  expect(rowIndicator(design({ unseen: true, agentState: "working", needsYou: 2 }))).toEqual({
    kind: "needs_you",
    count: 2,
  });
});

test("a waking sandbox reads as working; a limited or idle one as nothing", () => {
  expect(rowIndicator(design({ agentState: "waking" }))).toEqual({ kind: "working" });
  expect(rowIndicator(design({ agentState: "limited" }))).toBeNull();
});

test("the thread toggle follows the same order, with the thread's own unseen", () => {
  expect(railSignal(design({ unseen: true }), false)).toBe("idle");
  expect(railSignal(design(), true)).toBe("unseen");
  expect(railSignal(design({ agentState: "working" }), true)).toBe("working");
  expect(railSignal(design({ needsYou: 1, agentState: "working" }), true)).toEqual({ needsYou: 1 });
});

test("designs go by recency, and on a team what waits on you comes first", () => {
  const old = design({ id: "old", needsYou: 1, lastActivityAt: "2026-11-01T00:00:00.000Z" });
  const recent = design({ id: "recent", lastActivityAt: "2026-11-10T00:00:00.000Z" });
  const middle = design({ id: "middle", lastActivityAt: "2026-11-05T00:00:00.000Z" });
  const ids = (list: DesignSummary[]) => list.map((d) => d.id);
  expect(ids(orderDesigns([old, middle, recent], "personal"))).toEqual(["recent", "middle", "old"]);
  expect(ids(orderDesigns([middle, recent, old], "org"))).toEqual(["old", "recent", "middle"]);
});

test("the settled section shows every row open, and closed only the design you are in", () => {
  const older = design({ id: "a", status: "settled", settledAt: "2026-11-09T12:00:00.000Z" });
  const newer = design({ id: "b", status: "settled", settledAt: "2026-11-10T12:00:00.000Z" });
  expect(settledShown([older, newer], true, null).map((d) => d.id)).toEqual(["b", "a"]);
  expect(settledShown([older, newer], false, null)).toEqual([]);
  expect(settledShown([older, newer], false, "a").map((d) => d.id)).toEqual(["a"]);
  // A design that is open but not settled changes nothing here.
  expect(settledShown([older, newer], false, "elsewhere")).toEqual([]);
});

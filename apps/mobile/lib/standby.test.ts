import { expect, test } from "bun:test";
import type { AgentChange, Presence } from "@ponzu/core";
import {
  agentWorking,
  isStill,
  listenForStill,
  STILL_MS,
  standbyOn,
  standbyPath,
  standbyPose,
} from "./standby";

const inner = { width: 951, height: 669 };
const innerUpright = { width: 669, height: 951 };
// The tent: the outer display, which a portrait-only app keeps upright, with the hinge partly open.
const tent = { width: 466, height: 678 };
const outer = { width: 466, height: 678 };

test("standing (inner, partly open, sideways) and a tent (outer, on its side) are standby poses", () => {
  expect(standbyPose(inner, "partiallyOpen")).toBe(true);
  expect(standbyPose(tent, "partiallyOpen")).toBe(true);
});

test("flat, closed, upright like a laptop, or an iPhone: no standby", () => {
  expect(standbyPose(inner, "fullyOpen")).toBe(false);
  expect(standbyPose(outer, "closed")).toBe(false);
  expect(standbyPose(outer, "unknown")).toBe(false);
  expect(standbyPose(innerUpright, "partiallyOpen")).toBe(false);
  expect(standbyPose({ width: 402, height: 874 }, null)).toBe(false);
});

test("it needs the pose, the phone set down, and an agent working", () => {
  expect(standbyOn(true, true, true)).toBe(true);
  expect(standbyOn(true, false, true)).toBe(false);
  expect(standbyOn(true, true, false)).toBe(false);
  expect(standbyOn(false, true, true)).toBe(false);
});

test("gravity is read only once the pose and an agent hold: never on an iPhone", () => {
  expect(listenForStill(true, true)).toBe(true);
  expect(listenForStill(standbyPose({ width: 402, height: 874 }, null), true)).toBe(false);
  expect(listenForStill(true, false)).toBe(false);
  expect(listenForStill(false, false)).toBe(false);
});

test("still: gravity steady for the last moment; picked up: it moves", () => {
  const steady = Array.from({ length: 20 }, (_, i) => [i * 100, 0, -1, 0.01] as const);
  expect(isStill(steady)).toBe(true);
  // Too short a run to say.
  expect(isStill(steady.slice(-5))).toBe(false);
  const lifted = [...steady.slice(0, -1), [1900, 0.2, -0.9, 0.1] as const];
  expect(isStill(lifted)).toBe(false);
  expect(STILL_MS).toBeGreaterThan(1000);
});

const agent = (over: Partial<Presence>): Presence =>
  ({ id: "a", name: "Claude", kind: "agent", working: [], since: 0, ...over }) as Presence;
const change = (at: number, ids: string[], file = "/k.design"): AgentChange => ({
  id: `c${at}`,
  file,
  name: "Kettle",
  start: at,
  at,
  agent: { name: "Claude" },
  artboards: ids.map((id) => ({ id, name: id, page: "p" })),
  summary: "",
  kind: "changed",
});

test("the camera follows what the agent is working on now", () => {
  const page = new Set(["ab1", "ab2", "ab3"]);
  const path = standbyPath({
    presence: [agent({ working: ["ab2", "ab9"], file: "/k.design" })],
    changes: [change(5, ["ab1"])],
    file: "/k.design",
    page,
  });
  expect(path).toEqual(["ab2"]);
});

test("between edits, it falls back to the newest changes in the log, on this page", () => {
  const page = new Set(["ab1", "ab2", "ab3"]);
  const path = standbyPath({
    presence: [agent({ working: [] })],
    changes: [change(5, ["ab1"]), change(9, ["ab3", "ab2"]), change(7, ["ab2"], "/other.design")],
    file: "/k.design",
    page,
  });
  expect(path).toEqual(["ab3", "ab2", "ab1"]);
});

test("an agent working elsewhere isn't working here", () => {
  expect(agentWorking([agent({ working: ["x"], file: "/other.design" })], "/k.design")).toBe(false);
  expect(agentWorking([agent({ working: ["x"], file: "/k.design" })], "/k.design")).toBe(true);
});

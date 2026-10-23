import { expect, test } from "bun:test";
import type { Presence } from "@ponzu/core";
import { agentActivity } from "./working.tsx";

const now = 1_000_000;
const agent = (p: Partial<Presence> = {}): Presence => ({
  id: "agent_1",
  name: "Claude",
  kind: "agent",
  working: [],
  since: now - 60_000,
  lastSeen: now,
  ...p,
});

test("an agent working in this file is working", () => {
  expect(agentActivity(agent({ working: ["ab_1"], file: "/a.design" }), "/a.design", now)).toBe(
    "working",
  );
});

test("an agent working in another file doesn't show in this one", () => {
  expect(agentActivity(agent({ working: ["ab_1"], file: "/b.design" }), "/a.design", now)).toBe(
    null,
  );
});

test("an agent waiting for comments is watching, and stays so between waits", () => {
  const file = "/a.design";
  expect(agentActivity(agent({ file, listening: true }), file, now)).toBe("watching");
  expect(agentActivity(agent({ file, listenedAt: now - 30_000 }), file, now)).toBe("watching");
  // A loop that stopped a while ago, or a session that only ever read: hidden.
  expect(agentActivity(agent({ file, listenedAt: now - 10 * 60_000 }), file, now)).toBe(null);
  expect(agentActivity(agent({ file }), file, now)).toBe(null);
  expect(agentActivity(agent(), file, now)).toBe(null);
});

test("people never count as agents at work", () => {
  expect(agentActivity(agent({ kind: "user", working: ["ab_1"] }), "/a.design", now)).toBe(null);
});

import { expect, test } from "bun:test";
import { agentClientOf, driverNoticeLine, drivingLine, drivingTitle, sinceWhen } from "./driver.ts";
import type { Person, ThreadNotice } from "./model.ts";
import { clock } from "./time.ts";

const person = (id: string, name: string): Person => ({ id, name, login: id, avatarUrl: null });
const maya = person("usr_maya", "Maya Ortiz");
const sam = person("usr_sam", "Sam Lee");

type DriverNotice = Extract<ThreadNotice, { type: "driver" }>;
const notice = (patch: Partial<DriverNotice>): DriverNotice => ({
  type: "driver",
  action: "took",
  agent: "Claude Code",
  host: null,
  owner: maya,
  by: null,
  ...patch,
});

test("an agent's mark follows what it said it is", () => {
  expect(agentClientOf("claude-code/2.1.0")).toBe("claude");
  expect(agentClientOf("claude")).toBe("claude");
  expect(agentClientOf("codex-mcp-client/0.167.0")).toBe("openai");
  expect(agentClientOf("openai")).toBe("openai");
  expect(agentClientOf("Cursor/1.4")).toBe("cursor");
  expect(agentClientOf("t3")).toBe("t3");
  expect(agentClientOf("t3code/0.9")).toBe("t3");
  expect(agentClientOf("t3rminal")).toBe("other");
  expect(agentClientOf("zed")).toBe("other");
  expect(agentClientOf(null)).toBe("other");
});

test("the toggle's words name the agent, where it runs, since when, and where comments go", () => {
  const since = "2026-11-13T16:00:00";
  const now = Date.parse("2026-11-13T17:30:00");
  expect(drivingTitle({ name: "Claude Code" })).toBe("Claude Code is driving this canvas");
  expect(drivingLine({ host: "T3 Code", since }, now)).toBe(
    `In T3 Code · since ${clock(since)} · your comments go to it`,
  );
  expect(drivingLine({ host: null, since }, now)).toBe(
    `Since ${clock(since)} · your comments go to it`,
  );
  expect(drivingLine({ host: null, since: "" }, now)).toBe("Your comments go to it");
});

test("a drive begun another day says the day", () => {
  expect(sinceWhen("2026-11-12T16:00:00", Date.parse("2026-11-13T09:00:00"))).toBe("Nov 12");
  expect(sinceWhen("not a time", Date.now())).toBe("");
});

test("the thread says each turn of a drive in a quiet line", () => {
  expect(driverNoticeLine(notice({ host: "T3 Code" }), maya.id)).toBe(
    "Claude Code is driving this canvas (in T3 Code)",
  );
  expect(driverNoticeLine(notice({}), maya.id)).toBe("Claude Code is driving this canvas");
  expect(driverNoticeLine(notice({ action: "let_go" }), maya.id)).toBe(
    "Claude Code let go of the canvas",
  );
  expect(driverNoticeLine(notice({ action: "taken_back", by: maya }), sam.id)).toBe(
    "Maya took the canvas back",
  );
  expect(driverNoticeLine(notice({ action: "taken_back", by: maya }), maya.id)).toBe(
    "You took the canvas back",
  );
  expect(driverNoticeLine(notice({ action: "taken_back" }), maya.id)).toBe(
    "The canvas was taken back from Claude Code",
  );
  expect(driverNoticeLine(notice({ action: "lapsed" }), maya.id)).toBe(
    "Claude Code's turn ran out after 30 minutes without a call",
  );
  expect(driverNoticeLine(notice({ action: "revoked" }), maya.id)).toBe(
    "Claude Code was disconnected",
  );
  expect(driverNoticeLine(notice({ action: "revoked" }), sam.id)).toBe(
    "Claude Code was disconnected by Maya",
  );
});

import { expect, test } from "bun:test";
import type { MachineUpdate } from "@ponzu/core";
import { type Updater, waitForAgents } from "./updater.ts";

/** An app's updater that records each install it's asked for. */
function app(): Updater & { asked: { quiet?: boolean; version?: string }[] } {
  const asked: { quiet?: boolean; version?: string }[] = [];
  let now: MachineUpdate = { version: "1.43.0", ready: { version: "1.44.0", notes: [] } };
  return {
    asked,
    state: () => now,
    install: async (o = {}) => {
      asked.push(o);
      now = { ...now, installing: true };
      return now;
    },
    stop: () => {},
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an update the person asks for waits while an agent works, and says it's installing", async () => {
  const inner = app();
  let agent: string | undefined = "claude";
  const updater = waitForAgents(inner, () => agent, 10);
  const answer = await updater.install({ version: "1.44.0" });
  // Asked: it says so straight away, so Update shows it's under way on every Mac.
  expect(answer?.installing).toBe(true);
  expect(updater.state()?.installing).toBe(true);
  await tick(40);
  expect(inner.asked).toEqual([]);
  // The agent is done: the install goes ahead, with what was asked.
  agent = undefined;
  await tick(40);
  expect(inner.asked).toEqual([{ version: "1.44.0" }]);
  updater.stop();
});

test("with no agent working, and for a quiet catch-up, it installs at once", async () => {
  const inner = app();
  let agent: string | undefined;
  const updater = waitForAgents(inner, () => agent, 10);
  await updater.install({ version: "1.44.0" });
  expect(inner.asked).toEqual([{ version: "1.44.0" }]);
  // The app already declines a quiet install while anyone uses the Mac.
  agent = "openai";
  await updater.install({ quiet: true, version: "1.44.0" });
  expect(inner.asked).toHaveLength(2);
  updater.stop();
});

test("stopping drops an install still waiting for its agent", async () => {
  const inner = app();
  let agent: string | undefined = "claude";
  const updater = waitForAgents(inner, () => agent, 10);
  await updater.install({ version: "1.44.0" });
  updater.stop();
  agent = undefined;
  await tick(40);
  expect(inner.asked).toEqual([]);
});

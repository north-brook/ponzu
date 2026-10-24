import { expect, test } from "bun:test";
import { Listener, type ListenState, type Recognizer } from "./listen";

/** A recognizer whose permission prompts answer when the test says, and what was asked of it. */
function setup({ granted = true } = {}) {
  const calls: string[] = [];
  const states: ListenState[] = [];
  const prompts: ((granted: boolean) => void)[] = [];
  const rec: Recognizer = {
    available: () => true,
    requestPermissions: () => {
      calls.push("ask");
      return new Promise((resolve) => prompts.push((g) => resolve({ granted: g })));
    },
    onDevice: () => true,
    start: () => calls.push("start"),
    abort: () => calls.push("abort"),
  };
  const l = new Listener(rec, (s) => states.push(s));
  /** The person answers the oldest prompt still up. */
  const answer = async (g = granted) => {
    prompts.shift()!(g);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { l, calls, states, answer, prompts };
}

test("a first use starts the recognizer once the prompts are answered", async () => {
  const { l, calls, answer } = setup();
  l.start();
  expect(calls).toEqual(["ask"]);
  await answer(true);
  expect(calls).toEqual(["ask", "start"]);
});

test("a stop while the prompts are up wins: the stale start doesn't start the recognizer", async () => {
  const { l, calls, answer } = setup();
  l.start();
  l.stop();
  await answer(true);
  expect(calls).toEqual(["ask"]);
});

test("stopped and started again behind the prompts, it listens once they're answered", async () => {
  // The sheet re-renders under the prompt: its effect stops and starts again.
  const { l, calls, answer, prompts } = setup();
  l.start();
  l.stop();
  l.start();
  expect(prompts.length).toBe(2);
  // The second ask, made while the first prompt was up, comes back refused.
  await answer(true);
  await answer(false);
  expect(calls.filter((c) => c === "start")).toEqual([]);
  // The prompts close and the app is in front again: still wanted, so it asks and starts.
  l.resumed();
  await answer(true);
  expect(calls.at(-1)).toBe("start");
  expect(calls.filter((c) => c === "start").length).toBe(1);
});

test("start is idempotent: asking or listening already, another start does nothing", async () => {
  const { l, calls, answer } = setup();
  l.start();
  l.start();
  expect(calls).toEqual(["ask"]);
  await answer(true);
  l.start();
  l.resumed();
  expect(calls).toEqual(["ask", "start"]);
});

test("back in front while still asking, it waits for that answer rather than asking again", async () => {
  const { l, calls, answer } = setup();
  l.start();
  l.resumed();
  expect(calls).toEqual(["ask"]);
  await answer(true);
  expect(calls).toEqual(["ask", "start"]);
});

test("a recognizer that ended by itself starts again when the app comes back", async () => {
  const { l, calls, answer } = setup();
  l.start();
  await answer(true);
  l.ended();
  l.resumed();
  await answer(true);
  expect(calls).toEqual(["ask", "start", "ask", "start"]);
});

test("refused, it says so; stopped, it neither starts nor comes back", async () => {
  const { l, calls, states, answer } = setup();
  l.start();
  await answer(false);
  expect(states).toEqual(["denied"]);
  l.stop();
  l.resumed();
  expect(calls).toEqual(["ask"]);
});

test("a stop after listening aborts the recognizer", async () => {
  const { l, calls, answer } = setup();
  l.start();
  await answer(true);
  l.stop();
  l.stop();
  expect(calls).toEqual(["ask", "start", "abort"]);
});

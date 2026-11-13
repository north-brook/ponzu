import { expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";
import { type CardOutcome, type Scheduler, watchCardSetup } from "./card-setups.ts";

type Status = "waiting" | "added" | "cancelled" | "expired" | "failed";

/** A clock the test moves by hand: timers run only when it says, never on a real wait. */
function manualClock(): Scheduler & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.run();
        // Let the answer it asked for come back before the next timer.
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = until;
    },
    pending: () => timers.length,
  };
}

/** The API's answers, in turn (the last one stays), the app's links, and what was heard. */
function world(answers: (Status | Error)[], watchMs?: number) {
  const clock = manualClock();
  const asked: string[] = [];
  const outcomes: CardOutcome[] = [];
  let forward = 0;
  const listeners = new Set<(link: DeepLink) => void>();
  /** An answer the test lets come back when it chooses. */
  let held: (() => void) | null = null;
  let holdNext = false;
  const api = {
    billing: {
      cardSetup: async (id: string) => {
        asked.push(id);
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            held = resolve;
          });
        }
        if (next instanceof Error) throw next;
        return { status: next, workspaceId: "ws_1" };
      },
    },
  } as never;
  const watch = watchCardSetup({
    api,
    setupId: "ast_1",
    onLink: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    comeForward: () => forward++,
    onOutcome: (outcome) => outcomes.push(outcome),
    scheduler: clock,
    ...(watchMs ? { watchMs } : {}),
  });
  return {
    clock,
    watch,
    asked,
    outcomes,
    forward: () => forward,
    links: () => listeners.size,
    send: (link: DeepLink) => {
      for (const listener of [...listeners]) listener(link);
    },
    holdNextAnswer: () => {
      holdNext = true;
    },
    release: async () => {
      held?.();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("asks every two seconds until the card is added, then comes forward once", async () => {
  const w = world(["waiting", "waiting", "added"]);
  await w.clock.advance(1_999);
  expect(w.asked).toEqual([]);
  await w.clock.advance(1);
  expect(w.asked).toEqual(["ast_1"]);
  await w.clock.advance(4_000);
  expect(w.asked).toHaveLength(3);
  expect(w.outcomes).toEqual(["added"]);
  expect(w.forward()).toBe(1);
  // Done: nothing more is asked, and the link listener is gone.
  await w.clock.advance(60_000);
  expect(w.asked).toHaveLength(3);
  expect(w.links()).toBe(0);
});

test("the return page's link asks at once, and its word is never the outcome", async () => {
  const w = world(["waiting"]);
  w.send({ kind: "card_setup", setupId: "ast_1", result: "added" });
  await flush();
  expect(w.asked).toEqual(["ast_1"]);
  // The API says it is still waiting: no outcome from the link alone.
  expect(w.outcomes).toEqual([]);
  // Another setup's link is not this one's.
  w.send({ kind: "card_setup", setupId: "ast_2", result: "added" });
  await flush();
  expect(w.asked).toHaveLength(1);
  w.watch.stop();
});

test("the link and the poll at once make one outcome", async () => {
  const w = world(["added"]);
  w.holdNextAnswer();
  await w.clock.advance(2_000);
  expect(w.asked).toHaveLength(1);
  // The link arrives while the poll's answer is on its way: it waits for that answer.
  w.send({ kind: "card_setup", setupId: "ast_1", result: "added" });
  await flush();
  expect(w.asked).toHaveLength(1);
  await w.release();
  expect(w.outcomes).toEqual(["added"]);
  w.send({ kind: "card_setup", setupId: "ast_1", result: "added" });
  await flush();
  expect(w.outcomes).toEqual(["added"]);
  expect(w.forward()).toBe(1);
});

test("cancelled and expired are heard as they are; a network error is asked again", async () => {
  const cancelled = world([new ApiError(0, "network", "offline"), "cancelled"]);
  await cancelled.clock.advance(4_000);
  expect(cancelled.outcomes).toEqual(["cancelled"]);
  expect(cancelled.forward()).toBe(1);

  const gone = world([new ApiError(404, "not_found", "gone")]);
  await gone.clock.advance(2_000);
  expect(gone.outcomes).toEqual(["expired"]);
  expect(gone.forward()).toBe(0);
});

test("past the watch, a setup still waiting has expired", async () => {
  const w = world(["waiting"], 10_000);
  await w.clock.advance(9_999);
  expect(w.outcomes).toEqual([]);
  await w.clock.advance(2_000);
  expect(w.outcomes).toEqual(["expired"]);
  expect(w.clock.pending()).toBe(0);
});

test("stopped, it asks nothing and hears nothing", async () => {
  const w = world(["added"]);
  w.watch.stop();
  await w.clock.advance(10_000);
  w.send({ kind: "card_setup", setupId: "ast_1", result: "added" });
  await flush();
  expect([w.asked, w.outcomes]).toEqual([[], []]);
});

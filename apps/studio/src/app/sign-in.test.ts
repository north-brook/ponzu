import { expect, test } from "bun:test";
import { BACK_MS, COOLDOWN_MS, cooldown } from "./sign-in.tsx";

/** A window on a clock this test turns by hand. */
function fakeWindow(focused: boolean) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const win = {
    document: { hasFocus: () => focused },
    setTimeout: (run: () => void, ms: number) => {
      timers.set(next, { at: now + ms, run });
      return next++;
    },
    clearTimeout: (id: number | undefined) => {
      if (id !== undefined) timers.delete(id);
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  return {
    win: win as unknown as Parameters<typeof cooldown>[1],
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0]!;
        timers.delete(id);
        now = timer.at;
        timer.run();
      }
      now = until;
    },
    focus(value: boolean) {
      focused = value;
      if (value) for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
}

test("the browser opened behind the window: ready again once the cooldown is up", () => {
  const w = fakeWindow(true);
  let ready = 0;
  cooldown(() => ready++, w.win);
  // The window taking focus again changes nothing: it no longer ends anything early.
  w.focus(true);
  w.advance(COOLDOWN_MS - 1);
  expect(ready).toBe(0);
  w.advance(1);
  expect(ready).toBe(1);
});

test("the browser took the focus: ready a moment after the window is back, never sooner", () => {
  const w = fakeWindow(false);
  let ready = 0;
  cooldown(() => ready++, w.win);
  w.advance(COOLDOWN_MS + 60_000);
  expect(ready).toBe(0);
  w.focus(true);
  w.advance(BACK_MS - 1);
  expect(ready).toBe(0);
  w.advance(1);
  expect(ready).toBe(1);
});

test("stopping the wait (signed in, the screen gone) leaves nothing behind", () => {
  const w = fakeWindow(false);
  let ready = 0;
  const stop = cooldown(() => ready++, w.win);
  w.advance(COOLDOWN_MS);
  expect(w.listening()).toBe(1);
  stop();
  expect(w.listening()).toBe(0);
  w.focus(true);
  w.advance(BACK_MS);
  expect(ready).toBe(0);
});

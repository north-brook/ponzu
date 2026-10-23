import { expect, test } from "bun:test";
import { doubleTapFocus, type GestureHandlers, Gestures, HOLD_MS } from "./gestures.ts";

/** A recorder for what the fingers meant, with a clock the test moves. */
function setup() {
  const events: [string, ...unknown[]][] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  let now = 0;
  const on: GestureHandlers = {
    down: () => events.push(["down"]),
    pan: (dx, dy) => events.push(["pan", dx, dy]),
    pinchStart: (c) => events.push(["pinchStart", c]),
    pinch: (s, c) => events.push(["pinch", s, c]),
    release: (v, m) => events.push(["release", v, m]),
    tap: (p) => events.push(["tap", p]),
    doubleTap: (p) => events.push(["doubleTap", p]),
    longPress: (p) => events.push(["longPress", p]),
  };
  const g = new Gestures(on, (fn, ms) => {
    const t = { at: now + ms, fn, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (const t of timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)) {
      now = t.at;
      t.live = false;
      t.fn();
    }
    now = end;
  };
  return { g, events, advance, at: () => now };
}

const names = (events: [string, ...unknown[]][]) => events.map((e) => e[0]);

test("a quick touch is a tap; two close together, a double-tap", () => {
  const { g, events, advance, at } = setup();
  g.touchStart([{ id: 1, x: 100, y: 200 }], at());
  advance(80);
  g.touchEnd([{ id: 1 }], at());
  advance(120);
  g.touchStart([{ id: 2, x: 104, y: 203 }], at());
  advance(80);
  g.touchEnd([{ id: 2 }], at());
  expect(names(events)).toEqual(["down", "tap", "down", "doubleTap"]);
  expect(events.at(-1)![1]).toEqual({ x: 104, y: 203 });
});

test("a still finger held for half a second is a long-press, and nothing after", () => {
  const { g, events, advance, at } = setup();
  g.touchStart([{ id: 1, x: 50, y: 60 }], at());
  advance(HOLD_MS - 1);
  expect(names(events)).toEqual(["down"]);
  g.touchMove([{ id: 1, x: 53, y: 62 }], at());
  advance(1);
  expect(events.at(-1)).toEqual(["longPress", { x: 50, y: 60 }]);
  g.touchMove([{ id: 1, x: 120, y: 160 }], at());
  g.touchEnd([{ id: 1 }], at());
  expect(names(events)).toEqual(["down", "longPress"]);
});

test("a drag pans from past the slop, and a flick carries speed", () => {
  const { g, events, advance, at } = setup();
  g.touchStart([{ id: 1, x: 0, y: 0 }], at());
  for (let i = 1; i <= 10; i++) {
    advance(16);
    g.touchMove([{ id: 1, x: i * 16, y: 0 }], at());
  }
  g.touchEnd([{ id: 1 }], at());
  advance(HOLD_MS);
  const pans = events.filter((e) => e[0] === "pan");
  // Past the slop, the page catches up with the finger and then follows it: no lag behind it.
  expect(pans.reduce((s, e) => s + (e[1] as number), 0)).toBe(160);
  const release = events.at(-1)!;
  expect(release[0]).toBe("release");
  expect((release[1] as { x: number }).x).toBeCloseTo(1, 5);
  expect(names(events)).not.toContain("longPress");
  expect(names(events)).not.toContain("tap");
});

test("two fingers pinch about their centre, and lifting one carries on as a pan", () => {
  const { g, events, advance, at } = setup();
  g.touchStart([{ id: 1, x: 100, y: 400 }], at());
  g.touchStart([{ id: 2, x: 300, y: 400 }], at());
  expect(events.at(-1)).toEqual(["pinchStart", { x: 200, y: 400 }]);
  advance(16);
  g.touchMove(
    [
      { id: 1, x: 50, y: 400 },
      { id: 2, x: 350, y: 400 },
    ],
    at(),
  );
  expect(events.at(-1)).toEqual(["pinch", 1.5, { x: 200, y: 400 }]);
  g.touchEnd([{ id: 2 }], at());
  advance(16);
  g.touchMove([{ id: 1, x: 70, y: 410 }], at());
  expect(events.at(-1)).toEqual(["pan", 20, 10]);
  advance(HOLD_MS);
  g.touchEnd([{ id: 1 }], at());
  expect(events.at(-1)![0]).toBe("release");
  expect(names(events)).not.toContain("longPress");
});

test("a double-tap focuses the board under it, and never leaves a focused one", () => {
  expect(doubleTapFocus(null, "ab1")).toBe("ab1");
  expect(doubleTapFocus(null, null)).toBe(null);
  // Focused: no zoom out, and no jump to the board under the finger. Pinch out or pan past instead.
  expect(doubleTapFocus("ab1", "ab1")).toBe(null);
  expect(doubleTapFocus("ab1", "ab2")).toBe(null);
});

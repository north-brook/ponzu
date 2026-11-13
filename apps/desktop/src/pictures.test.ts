import { expect, test } from "bun:test";
import type { PictureAnswer, PictureRequest } from "./bridge.ts";
import { Pictures, pictureAnswer, pictureRequest } from "./pictures.ts";

/*
 * The hidden picture window, driven as main.ts drives it, with a window and a clock of the test's:
 * opened when a picture is asked for, one picture at a time, and closed when idle, after a few
 * pictures, when one takes too long or when the person's window goes.
 */

const request = (n: number): PictureRequest => ({
  doc: { n },
  threadId: `th_${n}`,
  messageId: `m_${n}`,
});
const drawn = (n: number): PictureAnswer => ({
  ok: true,
  light: new Uint8Array([n]),
  dark: new Uint8Array([n, n]),
});

function rig(opts: { perWindow?: number } = {}) {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let timerIds = 0;
  const windows: {
    sent: { id: number; request: PictureRequest }[];
    destroyed: boolean;
    ready: () => void;
    gone: () => void;
  }[] = [];
  const pictures = new Pictures({
    open: (events) => {
      const win = {
        sent: [] as { id: number; request: PictureRequest }[],
        destroyed: false,
        ...events,
      };
      windows.push(win);
      return {
        send: (id, request) => win.sent.push({ id, request }),
        destroy: () => {
          win.destroyed = true;
        },
      };
    },
    drawMs: 1_000,
    idleMs: 500,
    ...(opts.perWindow ? { perWindow: opts.perWindow } : {}),
    setTimer: (run, ms) => {
      timers.set(++timerIds, { run, ms });
      return timerIds;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  /** Runs every timer of `ms`. */
  const elapse = (ms: number) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms !== ms) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { pictures, windows, timers, elapse };
}

test("nothing opens until a picture is asked for; then one window draws them in turn", async () => {
  const { pictures, windows } = rig();
  expect(windows).toHaveLength(0);
  const first = pictures.draw(request(1));
  const second = pictures.draw(request(2));
  expect(windows).toHaveLength(1);
  // Nothing is sent before the studio there listens.
  expect(windows[0]!.sent).toEqual([]);
  windows[0]!.ready();
  expect(windows[0]!.sent.map((s) => s.request.messageId)).toEqual(["m_1"]);
  // An answer to anything but the picture being drawn is ignored.
  pictures.answered(99, drawn(99));
  pictures.answered(windows[0]!.sent[0]!.id, drawn(1));
  expect(await first).toEqual(drawn(1));
  expect(windows[0]!.sent.map((s) => s.request.messageId)).toEqual(["m_1", "m_2"]);
  pictures.answered(windows[0]!.sent[1]!.id, { ok: false, reason: "empty" });
  expect(await second).toEqual({ ok: false, reason: "empty" });
  expect(windows).toHaveLength(1);
});

test("the window closes once idle, and the next picture opens a new one", async () => {
  const { pictures, windows, elapse } = rig();
  const first = pictures.draw(request(1));
  windows[0]!.ready();
  pictures.answered(windows[0]!.sent[0]!.id, drawn(1));
  await first;
  expect(pictures.isOpen).toBe(true);
  elapse(500);
  expect(windows[0]!.destroyed).toBe(true);
  expect(pictures.isOpen).toBe(false);
  const next = pictures.draw(request(2));
  expect(windows).toHaveLength(2);
  windows[1]!.ready();
  pictures.answered(windows[1]!.sent[0]!.id, drawn(2));
  expect(await next).toEqual(drawn(2));
});

test("a picture asked for while idle keeps the window open", async () => {
  const { pictures, windows, elapse, timers } = rig();
  const first = pictures.draw(request(1));
  windows[0]!.ready();
  pictures.answered(windows[0]!.sent[0]!.id, drawn(1));
  await first;
  const second = pictures.draw(request(2));
  // The idle timer is gone; only the draw's is left.
  expect([...timers.values()].map((t) => t.ms)).toEqual([1_000]);
  elapse(500);
  expect(windows[0]!.destroyed).toBe(false);
  pictures.answered(windows[0]!.sent[1]!.id, drawn(2));
  expect(await second).toEqual(drawn(2));
});

test("a window is closed after its few pictures, so what Chromium keeps of them goes with it", async () => {
  const { pictures, windows } = rig({ perWindow: 2 });
  const answers = [1, 2, 3].map((n) => pictures.draw(request(n)));
  windows[0]!.ready();
  pictures.answered(windows[0]!.sent[0]!.id, drawn(1));
  pictures.answered(windows[0]!.sent[1]!.id, drawn(2));
  expect(windows[0]!.destroyed).toBe(true);
  expect(windows).toHaveLength(2);
  windows[1]!.ready();
  pictures.answered(windows[1]!.sent[0]!.id, drawn(3));
  expect(await Promise.all(answers)).toEqual([drawn(1), drawn(2), drawn(3)]);
  expect(pictures.opened).toBe(2);
});

test("a picture that takes too long fails, and its window is closed", async () => {
  const { pictures, windows, elapse } = rig();
  const stuck = pictures.draw(request(1));
  const next = pictures.draw(request(2));
  windows[0]!.ready();
  elapse(1_000);
  expect(await stuck).toEqual({
    ok: false,
    reason: "failed",
    message: "The picture took too long.",
  });
  expect(windows[0]!.destroyed).toBe(true);
  // A late answer from the closed window changes nothing.
  pictures.answered(windows[0]!.sent[0]!.id, drawn(1));
  windows[1]!.ready();
  pictures.answered(windows[1]!.sent[0]!.id, drawn(2));
  expect(await next).toEqual(drawn(2));
});

test("a window that goes away fails its picture; the next opens another", async () => {
  const { pictures, windows } = rig();
  const lost = pictures.draw(request(1));
  const next = pictures.draw(request(2));
  windows[0]!.ready();
  windows[0]!.gone();
  expect(await lost).toMatchObject({ ok: false, reason: "failed" });
  expect(windows).toHaveLength(2);
  windows[1]!.ready();
  pictures.answered(windows[1]!.sent[0]!.id, drawn(2));
  expect(await next).toEqual(drawn(2));
});

test("the person's window closing answers everything waiting and closes the picture window", async () => {
  const { pictures, windows, timers } = rig();
  const answers = [1, 2].map((n) => pictures.draw(request(n)));
  windows[0]!.ready();
  pictures.close();
  for (const answer of await Promise.all(answers)) {
    expect(answer).toMatchObject({ ok: false, reason: "failed" });
  }
  expect(windows[0]!.destroyed).toBe(true);
  expect(pictures.isOpen).toBe(false);
  expect(timers.size).toBe(0);
});

test("only a picture request in its shape is taken, and only an answer in its shape", () => {
  expect(pictureRequest(request(1))).toEqual(request(1));
  expect(pictureRequest({ ...request(1), assetBase: "https://assets.test/c" })).toMatchObject({
    assetBase: "https://assets.test/c",
  });
  expect(pictureRequest(null)).toBeNull();
  expect(pictureRequest({ ...request(1), doc: "x" })).toBeNull();
  expect(pictureRequest({ ...request(1), threadId: 3 })).toBeNull();
  expect(pictureRequest({ ...request(1), assetBase: 4 })).toBeNull();

  expect(pictureAnswer(drawn(1))).toEqual(drawn(1));
  expect(pictureAnswer({ ok: false, reason: "empty" })).toEqual({ ok: false, reason: "empty" });
  expect(pictureAnswer({ ok: false, reason: "failed", message: "no" })).toEqual({
    ok: false,
    reason: "failed",
    message: "no",
  });
  expect(pictureAnswer({ ok: true, light: "x", dark: "y" })).toMatchObject({ reason: "failed" });
  expect(pictureAnswer(undefined)).toMatchObject({ reason: "failed" });
});

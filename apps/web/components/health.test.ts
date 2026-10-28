import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { MARKER, READY_MS, watchHealth } from "./health.ts";

type Sent = [string, Record<string, string | boolean>];

// A tab: its sessionStorage outlives each page loaded in it, as it does in the browser.
function tab() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return {
    store,
    load(pathname = "/") {
      const doc = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        readyState: "complete",
      });
      const win = Object.assign(new EventTarget(), {
        document: doc,
        location: { pathname },
        sessionStorage: storage,
      });
      const sent: Sent[] = [];
      const mark = watchHealth((e, p) => sent.push([e, p]), win as unknown as Window);
      const show = (state: "visible" | "hidden") => {
        doc.visibilityState = state;
        doc.dispatchEvent(new Event("visibilitychange"));
      };
      return { win, sent, mark, show, leave: () => win.dispatchEvent(new Event("pagehide")) };
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a page killed while open is reported by the next load in its tab", () => {
  const t = tab();
  const first = t.load("/");
  expect(t.store.has(MARKER)).toBe(true);
  // iOS kills the page: no pagehide, no visibilitychange. Safari reloads it.
  const second = t.load("/");
  expect(first.sent).toEqual([]);
  expect(second.sent).toEqual([["page crashed", { page: "/", ready: false }]]);
});

test("a page left, reloaded or hidden is not a crash", () => {
  const t = tab();
  t.load("/").leave();
  expect(t.load("/").sent).toEqual([]);

  // Backgrounded, then iOS discards it for memory: that's not the page crashing.
  t.load("/").show("hidden");
  expect(t.load("/").sent).toEqual([]);
});

test("coming back on screen marks the page alive again", () => {
  const t = tab();
  const page = t.load("/download");
  page.show("hidden");
  expect(t.store.has(MARKER)).toBe(false);
  page.show("visible");
  expect(t.load("/").sent).toEqual([["page crashed", { page: "/download", ready: false }]]);
});

test("page ready after READY_MS on screen, once, and crashes after it say so", () => {
  const t = tab();
  const page = t.load("/");
  jest.advanceTimersByTime(READY_MS - 1);
  expect(page.sent).toEqual([]);
  // Going off screen restarts the count.
  page.show("hidden");
  page.show("visible");
  jest.advanceTimersByTime(READY_MS - 1);
  expect(page.sent).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(page.sent).toEqual([["page ready", { page: "/" }]]);
  page.show("hidden");
  page.show("visible");
  jest.advanceTimersByTime(READY_MS * 2);
  expect(page.sent).toHaveLength(1);

  expect(t.load("/").sent).toEqual([["page crashed", { page: "/", ready: true }]]);
});

test("the marker follows pages that change without a load", () => {
  const t = tab();
  const page = t.load("/");
  page.win.location.pathname = "/privacy";
  page.mark();
  expect(t.load("/privacy").sent).toEqual([["page crashed", { page: "/privacy", ready: false }]]);
});

test("a page reached without a load counts to ready on its own", () => {
  const t = tab();
  const page = t.load("/");
  // Before the first page is ready: the count starts again for the new one.
  jest.advanceTimersByTime(READY_MS - 1000);
  page.win.location.pathname = "/download";
  page.mark();
  jest.advanceTimersByTime(1000);
  expect(page.sent).toEqual([]);
  jest.advanceTimersByTime(READY_MS - 1000);
  expect(page.sent).toEqual([["page ready", { page: "/download" }]]);

  // After it: the next page gets its own, and a crash before then says it wasn't ready.
  page.win.location.pathname = "/privacy";
  page.mark();
  expect(t.load("/privacy").sent).toEqual([["page crashed", { page: "/privacy", ready: false }]]);
  jest.advanceTimersByTime(READY_MS);
  expect(page.sent.at(-1)).toEqual(["page ready", { page: "/privacy" }]);

  // The same path again (a pageview for a query or hash change) doesn't restart anything.
  page.mark();
  jest.advanceTimersByTime(READY_MS);
  expect(page.sent).toHaveLength(2);
});

test("blocked or broken storage only turns the signal off", () => {
  const throwing = Object.assign(new EventTarget(), {
    document: Object.assign(new EventTarget(), {
      visibilityState: "visible",
      readyState: "complete",
    }),
    location: { pathname: "/" },
  });
  Object.defineProperty(throwing, "sessionStorage", {
    get() {
      throw new Error("SecurityError");
    },
  });
  const sent: Sent[] = [];
  expect(() =>
    watchHealth((e, p) => sent.push([e, p]), throwing as unknown as Window),
  ).not.toThrow();

  const t = tab();
  t.store.set(MARKER, "{not json");
  expect(t.load("/").sent).toEqual([]);
});

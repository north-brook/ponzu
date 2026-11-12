import { describe, expect, test } from "bun:test";
import {
  type ClaudeConnection,
  connectionLine,
  duration,
  enteredKey,
  limitView,
  needsRenewal,
  pastedCode,
} from "./claude.ts";

// Local times, so the weekdays and clocks read the same in any time zone.
const now = new Date(2026, 10, 10, 11, 0).getTime();
const local = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).toISOString();

const max: ClaudeConnection = {
  method: "subscription",
  status: "connected",
  planLabel: "Claude Max",
  email: "bryce@northbrook.co",
  keyHint: null,
  connectedAt: local(2026, 10, 2, 12, 0),
  expiresAt: local(2027, 10, 2, 12, 0),
};

describe("the connected row", () => {
  test("names the plan and the account for a subscription", () => {
    expect(connectionLine(max)).toBe("Claude Max · bryce@northbrook.co · connected Nov 2");
  });

  test("falls back when Claude has not said which plan", () => {
    expect(connectionLine({ ...max, planLabel: null, email: null })).toBe(
      "Claude subscription · connected Nov 2",
    );
  });

  test("shows only a key's last four", () => {
    const key = { ...max, method: "api_key" as const, keyHint: "4f2a", expiresAt: null };
    expect(connectionLine(key)).toBe("Anthropic API key · sk-ant-…4f2a · connected Nov 2");
  });

  test("asks for a new sign-in from four weeks before the year is up", () => {
    expect(needsRenewal(max, now)).toBe(false);
    const soon = { ...max, expiresAt: local(2026, 11, 2, 12, 0) };
    expect(needsRenewal(soon, now)).toBe(true);
    expect(needsRenewal({ ...soon, status: "revoked" }, now)).toBe(false);
    expect(needsRenewal({ ...max, expiresAt: null }, now)).toBe(false);
  });
});

describe("limits", () => {
  test("the session resets in hours and minutes, a week on a weekday", () => {
    expect(
      limitView(
        { window: "session", utilization: 0.62, resetsAt: local(2026, 10, 10, 13, 14) },
        now,
      ),
    ).toEqual({ percent: 62, line: "Resets in 2 h 14 min", full: false });
    expect(
      limitView({ window: "week", utilization: 0.384, resetsAt: local(2026, 10, 16, 9, 0) }, now),
    ).toEqual({ percent: 38, line: "Resets Monday 9:00", full: false });
  });

  test("at 100% says how long canvases wait, and is not an error", () => {
    expect(
      limitView({ window: "session", utilization: 1, resetsAt: local(2026, 10, 10, 16, 0) }, now),
    ).toEqual({ percent: 100, line: "Canvases wait until 16:00", full: true });
    expect(
      limitView(
        { window: "week_opus", utilization: 1.02, resetsAt: local(2026, 10, 16, 9, 0) },
        now,
      ),
    ).toEqual({ percent: 100, line: "Canvases wait until Monday 9:00", full: true });
  });

  test("a window that has reset since it was seen reads empty", () => {
    expect(
      limitView({ window: "week", utilization: 0.9, resetsAt: local(2026, 10, 9, 9, 0) }, now),
    ).toEqual({ percent: 0, line: null, full: false });
  });

  test("before any canvas has run there is nothing to show", () => {
    expect(limitView({ window: "session", utilization: null, resetsAt: null }, now)).toEqual({
      percent: null,
      line: null,
      full: false,
    });
  });

  test("durations round up to the minute", () => {
    expect(duration(30_000)).toBe("1 min");
    expect(duration(40 * 60_000)).toBe("40 min");
    expect(duration(3 * 3_600_000)).toBe("3 h");
  });
});

describe("a pasted code", () => {
  test("is trimmed", () => {
    expect(pastedCode("  k7Hq2-Rw9xT#pL4mZ \n")).toBe("k7Hq2-Rw9xT#pL4mZ");
  });

  test("is lifted out of the words around it when only one part looks like a code", () => {
    expect(pastedCode("Authentication code: k7Hq2Rw9xT#pL4mZ copy it")).toBe("k7Hq2Rw9xT#pL4mZ");
  });

  test("is left as pasted when it is ambiguous", () => {
    expect(pastedCode("a#b c#d")).toBe("a#b c#d");
    expect(pastedCode("no code here")).toBe("no code here");
  });
});

describe("an entered key", () => {
  test("loses the space or line break a copy from the Console brings with it", () => {
    expect(enteredKey(" sk-ant-api03-abc_DEF-123 \n")).toBe("sk-ant-api03-abc_DEF-123");
    expect(enteredKey("sk-ant-api03-\nabc")).toBe("sk-ant-api03-abc");
  });
});

import { describe, expect, test } from "bun:test";
import {
  cancelReason,
  collapsesInto,
  type DeviceFacts,
  isStale,
  type PlanFacts,
  PUSH_TTL_S,
  planDelivery,
  prReadyHeld,
} from "./plan.ts";

const now = new Date("2026-11-10T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const later = (ms: number) => new Date(now.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const phone: DeviceFacts = {
  id: "dev_phone",
  platform: "ios",
  pingsEnabled: true,
  pingsBlocked: false,
  hasToken: true,
  lastSeenAt: ago(DAY),
  activeAt: null,
};
const mac: DeviceFacts = {
  id: "dev_mac",
  platform: "macos",
  pingsEnabled: true,
  pingsBlocked: false,
  hasToken: false,
  lastSeenAt: ago(MINUTE),
  activeAt: null,
};

function facts(over: Partial<PlanFacts> = {}): PlanFacts {
  return {
    kind: "reply",
    toggleOn: true,
    focusedAt: null,
    recentPushes: [],
    devices: [phone],
    ...over,
  };
}

const pushes = (count: number, kind: PlanFacts["kind"] = "reply", at = ago(MINUTE)) =>
  Array.from({ length: count }, () => ({ kind, at }));

describe("planDelivery", () => {
  test("a phone gets it at once", () => {
    expect(planDelivery(facts(), now)).toEqual({
      muted: false,
      readNow: null,
      pushes: [{ deviceId: "dev_phone", sendAt: now }],
      suppressed: null,
    });
  });

  test("toggle off: muted, the inbox row only", () => {
    expect(planDelivery(facts({ toggleOn: false }), now)).toEqual({
      muted: true,
      readNow: null,
      pushes: [],
      suppressed: "pref_off",
    });
  });

  test("billing is always on, whatever the toggle says", () => {
    expect(
      planDelivery(facts({ kind: "billing_cap_reached", toggleOn: false }), now).pushes,
    ).toHaveLength(1);
  });

  test("looking: focused within 75 seconds, the edge included", () => {
    expect(planDelivery(facts({ focusedAt: ago(75 * SECOND) }), now)).toEqual({
      muted: false,
      readNow: "looking",
      pushes: [],
      suppressed: "looking",
    });
    expect(planDelivery(facts({ focusedAt: ago(75 * SECOND + 1) }), now).suppressed).toBeNull();
  });

  test("the toggle is checked before looking", () => {
    expect(planDelivery(facts({ toggleOn: false, focusedAt: now }), now).suppressed).toBe(
      "pref_off",
    );
  });

  test("at a Mac within 120 seconds, the phone waits 120 seconds", () => {
    const atMac = (age: number) =>
      planDelivery(facts({ devices: [phone, { ...mac, activeAt: ago(age) }] }), now).pushes;
    expect(atMac(120 * SECOND)).toEqual([{ deviceId: "dev_phone", sendAt: later(120 * SECOND) }]);
    expect(atMac(120 * SECOND + 1)).toEqual([{ deviceId: "dev_phone", sendAt: now }]);
  });

  test("a phone active now does not defer the push: only a Mac does", () => {
    expect(planDelivery(facts({ devices: [{ ...phone, activeAt: now }] }), now).pushes).toEqual([
      { deviceId: "dev_phone", sendAt: now },
    ]);
  });

  test("20 pushes in the past hour: the 21st waits for the Mac", () => {
    expect(planDelivery(facts({ recentPushes: pushes(19) }), now).pushes).toHaveLength(1);
    expect(planDelivery(facts({ recentPushes: pushes(20) }), now)).toEqual({
      muted: false,
      readNow: null,
      pushes: [],
      suppressed: "rate",
    });
  });

  test("a push exactly an hour ago no longer counts", () => {
    const window = [...pushes(19), ...pushes(1, "reply", ago(60 * MINUTE))];
    expect(planDelivery(facts({ recentPushes: window }), now).suppressed).toBeNull();
    const inside = [...pushes(19), ...pushes(1, "reply", ago(60 * MINUTE - 1))];
    expect(planDelivery(facts({ recentPushes: inside }), now).suppressed).toBe("rate");
  });

  test("needs-you and billing neither count nor wait", () => {
    expect(
      planDelivery(facts({ recentPushes: pushes(40, "needs_you") }), now).suppressed,
    ).toBeNull();
    expect(
      planDelivery(facts({ kind: "needs_you", recentPushes: pushes(40) }), now).pushes,
    ).toHaveLength(1);
    expect(
      planDelivery(facts({ kind: "billing_free_used", recentPushes: pushes(40) }), now).pushes,
    ).toHaveLength(1);
  });

  test("which phones: on, not blocked, with a token, seen within 90 days", () => {
    const only = (device: DeviceFacts) => planDelivery(facts({ devices: [device] }), now);
    expect(only({ ...phone, pingsEnabled: false }).suppressed).toBe("no_device");
    expect(only({ ...phone, pingsBlocked: true }).suppressed).toBe("no_device");
    expect(only({ ...phone, hasToken: false }).suppressed).toBe("no_device");
    expect(only({ ...phone, lastSeenAt: ago(90 * DAY) }).suppressed).toBeNull();
    expect(only({ ...phone, lastSeenAt: ago(90 * DAY + 1) }).suppressed).toBe("no_device");
    expect(only(mac).suppressed).toBe("no_device");
    // A Mac is never pushed to, even one that somehow has a token.
    expect(only({ ...mac, hasToken: true, lastSeenAt: now }).suppressed).toBe("no_device");
  });

  test("every phone that takes pings gets one", () => {
    const second = { ...phone, id: "dev_ipad" };
    expect(planDelivery(facts({ devices: [phone, second, mac] }), now).pushes).toEqual([
      { deviceId: "dev_phone", sendAt: now },
      { deviceId: "dev_ipad", sendAt: now },
    ]);
  });
});

describe("at send time", () => {
  const waiting = {
    pushEnabled: true,
    kind: "needs_you" as const,
    createdAt: ago(MINUTE),
    readAt: null,
    resolvedAt: null,
    toggleOn: true,
    device: phone,
    canRead: true,
  };

  test("it goes", () => {
    expect(cancelReason(waiting, now)).toBeNull();
  });

  test("each reason to cancel", () => {
    expect(cancelReason({ ...waiting, pushEnabled: false }, now)).toBe("push_off");
    expect(cancelReason({ ...waiting, readAt: now }, now)).toBe("read");
    expect(cancelReason({ ...waiting, resolvedAt: now }, now)).toBe("resolved");
    expect(cancelReason({ ...waiting, toggleOn: false }, now)).toBe("pref_off");
    expect(cancelReason({ ...waiting, device: null }, now)).toBe("device_off");
    expect(cancelReason({ ...waiting, device: { ...phone, pingsBlocked: true } }, now)).toBe(
      "device_off",
    );
    expect(cancelReason({ ...waiting, canRead: false }, now)).toBe("access");
    expect(cancelReason({ ...waiting, createdAt: ago(30 * MINUTE + 1) }, now)).toBe("stale");
  });

  test("resolved only cancels a needs-you; billing ignores the toggle", () => {
    expect(cancelReason({ ...waiting, kind: "reply", resolvedAt: now }, now)).toBeNull();
    expect(
      cancelReason({ ...waiting, kind: "billing_cap_warning", toggleOn: false }, now),
    ).toBeNull();
  });

  test("stale is more than 30 minutes late: exactly 30 still goes", () => {
    expect(isStale(ago(30 * MINUTE), now)).toBe(false);
    expect(isStale(ago(30 * MINUTE + 1), now)).toBe(true);
    expect(PUSH_TTL_S).toBe(3600);
  });
});

describe("collapse and the pull request throttle", () => {
  test("comments collapse within 10 minutes, the edge included", () => {
    expect(collapsesInto(ago(10 * MINUTE), now)).toBe(true);
    expect(collapsesInto(ago(10 * MINUTE + 1), now)).toBe(false);
  });

  test("ready pings at most once per 30 minutes; exactly 30 on, it pings again", () => {
    expect(prReadyHeld(null, now)).toBe(false);
    expect(prReadyHeld(ago(30 * MINUTE - 1), now)).toBe(true);
    expect(prReadyHeld(ago(30 * MINUTE), now)).toBe(false);
  });
});

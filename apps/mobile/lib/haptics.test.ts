import { expect, mock, test } from "bun:test";

const calls: string[] = [];
mock.module("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  impactAsync: async (s: string) => calls.push(`impact:${s}`),
  selectionAsync: async () => calls.push("selection"),
  notificationAsync: async (t: string) => {
    calls.push(`notification:${t}`);
    if (t === "error") throw new Error("no taptic engine");
  },
}));
const h = await import("./haptics");

test("each word is one system haptic", async () => {
  const told: string[] = [];
  h.onHaptic((k) => told.push(k));
  h.tick();
  h.select();
  h.success();
  h.thud();
  h.warn();
  h.fail();
  await Promise.resolve();
  expect(calls).toEqual([
    "impact:light",
    "selection",
    "notification:success",
    "impact:medium",
    "notification:warning",
    "notification:error",
  ]);
  expect(told).toEqual(["tick", "select", "success", "thud", "warn", "fail"]);
  h.onHaptic(null);
});

test("a failing haptic is silent", async () => {
  expect(() => h.fail()).not.toThrow();
  // The rejected promise is caught: nothing reaches the test runner.
  await new Promise((r) => setTimeout(r, 0));
});

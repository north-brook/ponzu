import { mock, test } from "bun:test";

const broken = async () => {
  throw new Error("no taptic engine");
};
mock.module("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  impactAsync: broken,
  selectionAsync: broken,
  notificationAsync: broken,
}));
const h = await import("./haptics");

test("a failing haptic is silent", async () => {
  // Called as the app calls them, not awaited and not inside an expect, which would swallow
  // what is thrown. A rejection nobody caught fails this test.
  for (const haptic of [h.tick, h.select, h.success, h.thud, h.warn, h.fail]) haptic();
  await new Promise((r) => setTimeout(r, 0));
});

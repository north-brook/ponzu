import { expect, mock, test } from "bun:test";

mock.module("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
const { isActive } = await import("./app-active");

test("in front while active or not yet known; the switcher and the background aren't", () => {
  expect(isActive("active")).toBe(true);
  expect(isActive(null)).toBe(true);
  expect(isActive("unknown")).toBe(true);
  expect(isActive("inactive")).toBe(false);
  expect(isActive("background")).toBe(false);
});

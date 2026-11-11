import { expect, test } from "bun:test";
import { jumpDigit, jumpNumber, jumpTarget } from "./shortcut.ts";

const key = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  isComposing: false,
});

test("⌘ and Ctrl take 0–9 for designs; ⌥ takes 1–9 for pages", () => {
  expect(jumpDigit(key("Digit1", { meta: true }), "design")).toBe(1);
  expect(jumpDigit(key("Digit0", { meta: true }), "design")).toBe(0);
  expect(jumpDigit(key("Digit9", { ctrl: true }), "design")).toBe(9);
  expect(jumpDigit(key("Digit3", { alt: true }), "page")).toBe(3);
  expect(jumpDigit(key("Digit0", { alt: true }), "page")).toBeNull();
  // Each modifier is its own: ⌘ doesn't change pages, ⌥ doesn't open designs.
  expect(jumpDigit(key("Digit1", { alt: true }), "design")).toBeNull();
  expect(jumpDigit(key("Digit1", { meta: true }), "page")).toBeNull();
});

test("a number with ⇧, with both modifiers, from the keypad or while composing jumps nowhere", () => {
  expect(jumpDigit(key("Digit1", { meta: true, shift: true }), "design")).toBeNull();
  expect(jumpDigit(key("Digit1", { meta: true, alt: true }), "design")).toBeNull();
  expect(jumpDigit(key("Digit1", { meta: true, alt: true }), "page")).toBeNull();
  expect(jumpDigit(key("Numpad1", { meta: true }), "design")).toBeNull();
  expect(jumpDigit(key("KeyB", { meta: true }), "design")).toBeNull();
  expect(jumpDigit({ ...key("Digit1", { meta: true }), isComposing: true }, "design")).toBeNull();
  // No modifier: a digit typed anywhere is just a digit.
  expect(jumpDigit(key("Digit1"), "design")).toBeNull();
  expect(jumpDigit(key("Digit1"), "page")).toBeNull();
});

test("1–8 are the first eight and 9 the last, however many there are", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i);
  expect(jumpTarget(twelve, 1)).toBe(0);
  expect(jumpTarget(twelve, 8)).toBe(7);
  expect(jumpTarget(twelve, 9)).toBe(11);
  expect(jumpTarget(twelve, 0)).toBeUndefined();
  const three = ["a", "b", "c"];
  expect(jumpTarget(three, 3)).toBe("c");
  expect(jumpTarget(three, 4)).toBeUndefined();
  expect(jumpTarget(three, 9)).toBe("c");
  expect(jumpTarget([], 9)).toBeUndefined();
});

test("the hints number the first eight and the last; the rest show none", () => {
  expect(Array.from({ length: 12 }, (_, i) => jumpNumber(i, 12))).toEqual([
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    undefined,
    undefined,
    undefined,
    9,
  ]);
  // Nine exactly: the ninth is both the ninth and the last.
  expect(jumpNumber(8, 9)).toBe(9);
  expect(Array.from({ length: 3 }, (_, i) => jumpNumber(i, 3))).toEqual([1, 2, 3]);
});

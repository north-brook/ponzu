import { expect, test } from "bun:test";
import { hotkeyName, jumpDigit, jumpNumber, jumpTarget, shortcutPress } from "./shortcut.ts";

const press = (
  key: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift" | "repeat" | "composing", boolean>> = {},
  code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
) => ({
  key,
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  repeat: mods.repeat ?? false,
  isComposing: mods.composing ?? false,
});

test("⌘P is the pull request's and ⌘⇧↵ the action's: no other modifiers, Ctrl off the Mac", () => {
  expect(shortcutPress(press("p", { meta: true }), "p")).toBe("run");
  expect(shortcutPress(press("p", { ctrl: true }), "p")).toBe("run");
  // ⇧ or ⌥ with it, or no ⌘ at all, is another key's.
  expect(shortcutPress(press("P", { meta: true, shift: true }), "p")).toBeNull();
  expect(shortcutPress(press("p", { meta: true, alt: true }), "p")).toBeNull();
  expect(shortcutPress(press("p"), "p")).toBeNull();
  const action = { shift: true, once: true };
  expect(shortcutPress(press("Enter", { meta: true, shift: true }), "enter", action)).toBe("run");
  // ⌘↵ alone is the composer's send; ⇧↵ its line break; a key mid-composition is the IME's.
  expect(shortcutPress(press("Enter", { meta: true }), "enter", action)).toBeNull();
  expect(shortcutPress(press("Enter", { shift: true }), "enter", action)).toBeNull();
  expect(
    shortcutPress(press("Enter", { meta: true, shift: true, composing: true }), "enter", action),
  ).toBeNull();
  expect(hotkeyName("enter", true)).toBe("mod+shift+enter");
  expect(hotkeyName("p")).toBe("mod+p");
});

test("a shortcut that can't run now leaves the key alone; one that runs once runs once a press", () => {
  // Under a menu, or with the button disabled: not taken at all.
  expect(shortcutPress(press("p", { meta: true }), "p", { when: () => false })).toBeNull();
  const once = { shift: true, once: true };
  const seen = new WeakSet<object>();
  const e = press("Enter", { meta: true, shift: true });
  expect(shortcutPress(e, "enter", once, seen)).toBe("run");
  // Another of it mounted at once hears the same press: taken, not run again.
  expect(shortcutPress(e, "enter", once, seen)).toBe("taken");
  // Held down, the key repeats: taken, not run.
  const held = press("Enter", { meta: true, shift: true, repeat: true });
  expect(shortcutPress(held, "enter", once, seen)).toBe("taken");
  // Without `once`, a held ⌘B toggles as it always did.
  expect(shortcutPress(press("b", { meta: true, repeat: true }), "b")).toBe("run");
});

test("⌥⌘B is the thread's and ⌘B the sidebar's: ⌥ tells them apart, whatever ⌥ makes the key type", () => {
  const thread = { alt: true };
  // On a Mac ⌥B types "∫": the key is read from its place on the keyboard.
  expect(shortcutPress(press("∫", { meta: true, alt: true }, "KeyB"), "b", thread)).toBe("run");
  expect(shortcutPress(press("b", { ctrl: true, alt: true }), "b", thread)).toBe("run");
  // Each leaves the other's press alone.
  expect(shortcutPress(press("b", { meta: true }), "b", thread)).toBeNull();
  expect(shortcutPress(press("∫", { meta: true, alt: true }, "KeyB"), "b")).toBeNull();
  // ⇧ as well, or another key in that place, is neither.
  expect(
    shortcutPress(press("ı", { meta: true, alt: true, shift: true }, "KeyB"), "b", thread),
  ).toBeNull();
  expect(shortcutPress(press("√", { meta: true, alt: true }, "KeyV"), "b", thread)).toBeNull();
  expect(hotkeyName("b", false, true)).toBe("mod+alt+b");
});

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

test("on a Mac ⌘ takes 0–9 for canvases and ⌃ takes 1–9 for pages", () => {
  expect(jumpDigit(key("Digit1", { meta: true }), "canvas", true)).toBe(1);
  expect(jumpDigit(key("Digit0", { meta: true }), "canvas", true)).toBe(0);
  expect(jumpDigit(key("Digit3", { ctrl: true }), "page", true)).toBe(3);
  expect(jumpDigit(key("Digit0", { ctrl: true }), "page", true)).toBeNull();
  // Each modifier is its own: ⌘ doesn't change pages, ⌃ doesn't open canvases, ⌥ does neither.
  expect(jumpDigit(key("Digit1", { ctrl: true }), "canvas", true)).toBeNull();
  expect(jumpDigit(key("Digit1", { meta: true }), "page", true)).toBeNull();
  expect(jumpDigit(key("Digit1", { alt: true }), "page", true)).toBeNull();
  expect(jumpDigit(key("Digit1", { alt: true }), "canvas", true)).toBeNull();
});

test("off the Mac Ctrl takes the canvases and Alt the pages", () => {
  expect(jumpDigit(key("Digit9", { ctrl: true }), "canvas", false)).toBe(9);
  expect(jumpDigit(key("Digit0", { ctrl: true }), "canvas", false)).toBe(0);
  expect(jumpDigit(key("Digit3", { alt: true }), "page", false)).toBe(3);
  expect(jumpDigit(key("Digit0", { alt: true }), "page", false)).toBeNull();
  expect(jumpDigit(key("Digit1", { ctrl: true }), "page", false)).toBeNull();
  expect(jumpDigit(key("Digit1", { alt: true }), "canvas", false)).toBeNull();
});

test("a number with ⇧, with two modifiers, from the keypad or while composing jumps nowhere", () => {
  for (const onMac of [true, false]) {
    expect(jumpDigit(key("Digit1", { meta: true, shift: true }), "canvas", onMac)).toBeNull();
    expect(jumpDigit(key("Digit1", { ctrl: true, shift: true }), "page", onMac)).toBeNull();
    expect(jumpDigit(key("Digit1", { meta: true, alt: true }), "canvas", onMac)).toBeNull();
    expect(jumpDigit(key("Digit1", { meta: true, ctrl: true }), "canvas", onMac)).toBeNull();
    expect(jumpDigit(key("Digit1", { ctrl: true, alt: true }), "page", onMac)).toBeNull();
    expect(jumpDigit(key("Numpad1", { meta: true }), "canvas", onMac)).toBeNull();
    expect(jumpDigit(key("KeyB", { meta: true }), "canvas", onMac)).toBeNull();
    expect(
      jumpDigit({ ...key("Digit1", { meta: true }), isComposing: true }, "canvas", onMac),
    ).toBeNull();
    // No modifier: a digit typed anywhere is just a digit.
    expect(jumpDigit(key("Digit1"), "canvas", onMac)).toBeNull();
    expect(jumpDigit(key("Digit1"), "page", onMac)).toBeNull();
  }
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

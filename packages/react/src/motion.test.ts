import { expect, test } from "bun:test";
import { key, MOTION_CSS, ms, same } from "./motion.ts";

test("animation times parse in either unit", () => {
  expect(ms("1.2s")).toBe(1200);
  expect(ms(" -700ms")).toBe(-700);
  expect(ms("0s")).toBe(0);
});

test("an end on the identity transform reads as none", () => {
  expect(same("matrix(1, 0, 0, 1, 0, 0)")).toBe("none");
  expect(same("matrix(1, 0, 0, 1, 4, 0)")).toBe("matrix(1, 0, 0, 1, 4, 0)");
});

test("an animation's key is the same from the animation and from its events", () => {
  // CSSAnimation.effect.pseudoElement is null on the element; AnimationEvent.pseudoElement is "".
  expect(key(null, "spin")).toBe(key("", "spin"));
  expect(key("::before", "spin")).not.toBe(key(null, "spin"));
});

test("a field hides its live elements only while its image stands in", () => {
  expect(MOTION_CSS).toContain("[data-pz-field] > :not([data-pz-image])");
  expect(MOTION_CSS).toContain(":not([data-pz-field]) > [data-pz-image]");
});

import { expect, test } from "bun:test";
import { FIELD_LINE, FIELD_MAX, FIELD_PAD, fieldScrolls } from "./field";

test("the field scrolls only once it's as tall as it gets, five lines", () => {
  expect(FIELD_PAD * 2 + FIELD_LINE).toBe(44);
  expect(FIELD_MAX).toBe(132);
  expect(fieldScrolls(44)).toBe(false);
  expect(fieldScrolls(FIELD_PAD * 2 + FIELD_LINE * 4)).toBe(false);
  // A hair under, as iOS reports it at times.
  expect(fieldScrolls(131.5)).toBe(true);
  expect(fieldScrolls(FIELD_MAX)).toBe(true);
  expect(fieldScrolls(FIELD_PAD * 2 + FIELD_LINE * 7)).toBe(true);
});

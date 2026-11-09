import { expect, test } from "bun:test";
import { FIELD_LINE, FIELD_PAD, FIELD_SPACING, INTER_LINE } from "./field";

test("one line fills the buttons' 44, and lines sit 22pt apart", () => {
  expect(FIELD_PAD * 2 + INTER_LINE).toBeCloseTo(44);
  expect(INTER_LINE + FIELD_SPACING).toBe(FIELD_LINE);
  expect(FIELD_SPACING).toBeGreaterThan(0);
});

import { expect, test } from "bun:test";
import { FIELD_LINE, FIELD_MAX, FIELD_PAD } from "./field";

test("one line fills the buttons' 44, and the field stops growing at five", () => {
  expect(FIELD_PAD * 2 + FIELD_LINE).toBe(44);
  expect(FIELD_MAX).toBe(132);
});

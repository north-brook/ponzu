import { expect, test } from "bun:test";
import { CREATE_KEY, nameFor } from "./create.ts";

test("a new canvas is named for what its prompt is about", () => {
  expect(nameFor("  A pricing page\nwith three plans")).toBe("Pricing page");
  expect(nameFor("Design a quieter shop hero. Keep the photo.")).toBe("Quieter shop hero");
  expect(nameFor("make the checkout calmer — fewer fields")).toBe("Checkout calmer");
  expect(nameFor("x".repeat(60))).toBe(`X${"x".repeat(39)}…`);
});

test("a UUID is a create key the API takes", () => {
  expect(CREATE_KEY.test("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
  expect(CREATE_KEY.test("short")).toBe(false);
});

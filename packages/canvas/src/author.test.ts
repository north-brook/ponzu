import { expect, test } from "bun:test";
import { sameAuthor } from "./Comments.tsx";

test("an author is the same person by id when both carry one, whatever their names", () => {
  const maya = { kind: "user", id: "usr_1", name: "Maya" } as const;
  expect(sameAuthor(maya, { kind: "user", id: "usr_1", name: "Maya Lin" })).toBe(true);
  expect(sameAuthor(maya, { kind: "user", id: "usr_2", name: "Maya" })).toBe(false);
});

test("without ids, as the local app's comments are, the kind and name decide", () => {
  expect(sameAuthor({ kind: "user", name: "Sam" }, { kind: "user", name: "Sam" })).toBe(true);
  expect(sameAuthor({ kind: "user", name: "Sam" }, { kind: "agent", name: "Sam" })).toBe(false);
  expect(
    sameAuthor({ kind: "user", name: "Sam" }, { kind: "user", id: "usr_1", name: "Sam" }),
  ).toBe(true);
});

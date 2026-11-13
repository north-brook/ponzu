import { expect, test } from "bun:test";
import { plainText } from "./plain.ts";

// What search keeps of an agent's answer: the words a person reads, a block to a line. The API
// and the client's fake backend both use this, so the two find the same answers.

test("blocks become lines, with the marks and link targets gone", () => {
  expect(
    plainText(
      "# Pricing\n\nThe **card** has [a link](https://example.test/target) and `code`.\n\n- one\n- two\n\n> quoted\n\n![alt words](https://example.test/picture.png)",
    ),
  ).toBe("Pricing\nThe card has a link and code.\none\ntwo\nquoted\nalt words");
});

test("a reference link keeps its text, and its definition is never searched", () => {
  expect(plainText("See [Pricing][price].\n\n[price]: https://example.test/hiddenword")).toBe(
    "See Pricing.",
  );
});

test("a rule and empty blocks leave nothing", () => {
  expect(plainText("one\n\n---\n\n   \n\ntwo")).toBe("one\ntwo");
});

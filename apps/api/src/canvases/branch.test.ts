import { expect, test } from "bun:test";
import { branchFor, branchTopic } from "./branch.ts";

test("a topic is the first words of a message that say something", () => {
  expect(branchTopic("Make the pricing page calmer, with a quieter hero")).toBe(
    "pricing-page-calmer",
  );
  expect(branchTopic("Can you redo the onboarding?")).toBe("onboarding");
  expect(branchTopic("A new canvas for the checkout")).toBe("checkout");
  expect(branchTopic("Café menu — größer!")).toBe("cafe-menu-grosser");
  expect(branchTopic("🎨✨")).toBe("canvas");
  expect(branchTopic("")).toBe("canvas");
});

test("a topic is short enough to read in a list of pull requests", () => {
  const topic = branchTopic("internationalization accessibility responsiveness performance");
  expect(topic.length).toBeLessThanOrEqual(40);
  expect(topic).toBe("internationalization-accessibility");
});

test("a branch already taken gets the first number after it that is free", () => {
  expect(branchFor("hero", [])).toBe("pz/hero");
  expect(branchFor("hero", ["pz/hero"])).toBe("pz/hero-2");
  expect(branchFor("hero", ["pz/hero", "pz/hero-2", "pz/hero-4"])).toBe("pz/hero-3");
});

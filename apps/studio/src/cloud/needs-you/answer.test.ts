import { expect, test } from "bun:test";
import type { Ask } from "../model.ts";
import { answerable, answerOf, choose, type Draft, EMPTY_DRAFT, pagesOf } from "./answer.ts";

const headline: Ask = {
  id: "q_headline",
  status: "open",
  answeredBy: null,
  kind: "question",
  questions: [
    {
      header: "Headline",
      question: "The headline runs to three lines at 390px. Which way?",
      options: [
        { label: "Shorten it", description: "" },
        { label: "Smaller type on phones", description: "" },
      ],
      multiSelect: false,
    },
    {
      header: "Pages",
      question: "Which pages get it?",
      options: [
        { label: "Home", description: "" },
        { label: "Product", description: "" },
        { label: "Care cards", description: "" },
      ],
      multiSelect: true,
    },
  ],
};
const plan: Ask = { id: "q_plan", status: "open", answeredBy: null, kind: "plan", plan: "1. A" };
const permission: Ask = {
  id: "q_perm",
  status: "open",
  answeredBy: null,
  kind: "permission",
  tool: "Bash",
  title: "Run the migrations",
  description: null,
};
const secret: Ask = {
  id: "q_secret",
  status: "open",
  answeredBy: null,
  kind: "secret",
  name: "STRIPE_KEY",
  description: null,
};

const draft = (over: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...over });

test("every question of an ask is a page, and every other ask is one", () => {
  expect(pagesOf([headline, plan]).map((p) => [p.ask.id, p.index])).toEqual([
    ["q_headline", 0],
    ["q_headline", 1],
    ["q_plan", 0],
  ]);
});

test("choosing: one option replaces another, several join and leave", () => {
  const single = choose(choose(EMPTY_DRAFT, "Shorten it", false), "Smaller type", false);
  expect(single.chosen).toEqual(["Smaller type"]);
  // Choosing the chosen one again clears it.
  expect(choose(single, "Smaller type", false).chosen).toEqual([]);
  let multi = choose(EMPTY_DRAFT, "Product", true);
  multi = choose(multi, "Home", true);
  expect(multi.chosen).toEqual(["Product", "Home"]);
  expect(choose(multi, "Product", true).chosen).toEqual(["Home"]);
});

test("send waits until the page says something", () => {
  const [first] = pagesOf([headline]);
  expect(answerable(first!, EMPTY_DRAFT)).toBe(false);
  expect(answerable(first!, draft({ note: "   " }))).toBe(false);
  expect(answerable(first!, draft({ note: "Cut it to two lines" }))).toBe(true);
  expect(answerable(first!, draft({ chosen: ["Shorten it"] }))).toBe(true);
  const [perm] = pagesOf([permission]);
  // A permission needs a yes or a no; a note alone isn't one.
  expect(answerable(perm!, draft({ note: "sure?" }))).toBe(false);
  expect(answerable(perm!, draft({ chosen: ["no"] }))).toBe(true);
  // A plan is approved, or told what to change.
  const [p] = pagesOf([plan]);
  expect(answerable(p!, draft({ note: "Do C first" }))).toBe(true);
  const [s] = pagesOf([secret]);
  expect(answerable(s!, EMPTY_DRAFT)).toBe(false);
  expect(answerable(s!, draft({ note: "sk_test_123" }))).toBe(true);
});

test("an ask's answer needs every page, keyed by question text in the options' order", () => {
  expect(answerOf(headline, [draft({ chosen: ["Shorten it"] })])).toBeNull();
  expect(
    answerOf(headline, [
      draft({ chosen: ["Shorten it"], note: "keep the comma" }),
      draft({ chosen: ["Care cards", "Home"] }),
    ]),
  ).toEqual({
    answers: {
      "The headline runs to three lines at 390px. Which way?": "Shorten it. keep the comma",
      "Which pages get it?": "Home, Care cards",
    },
  });
  expect(answerOf(plan, [draft({ chosen: ["yes"] })])).toEqual({ approved: true });
  expect(answerOf(plan, [draft({ note: "Do C first" })])).toEqual({
    approved: false,
    note: "Do C first",
  });
  expect(answerOf(permission, [draft({ chosen: ["no"], note: "not on prod" })])).toEqual({
    approved: false,
    note: "not on prod",
  });
  expect(answerOf(secret, [draft({ note: "sk_test_123" })])).toEqual({ secret: "sk_test_123" });
});

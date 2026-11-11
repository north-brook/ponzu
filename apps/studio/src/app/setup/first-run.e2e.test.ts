/*
 * Between the guided steps, with slow answers (slow-answers.e2e-lib.ts). Every answer equally slow.
 */
import { test } from "bun:test";
import { slowAnswers } from "./slow-answers.e2e-lib.ts";

slowAnswers(({ walk }) => {
  test("a new person sees each step, then the next, and nothing in between", () => walk(""));
});

/*
 * Between the guided steps, with slow answers (slow-answers.e2e-lib.ts). Each answer its own delay, so they arrive out of order.
 */
import { test } from "bun:test";
import { slowAnswers } from "./slow-answers.e2e-lib.ts";

slowAnswers(({ walk }) => {
  test("so they do when every answer takes its own time", () => walk("&jitter=7"));
});

/*
 * Between the guided steps, with slow answers (slow-answers.e2e-lib.ts). Who the person is, far behind every other answer.
 */
import { test } from "bun:test";
import { slowAnswers } from "./slow-answers.e2e-lib.ts";

slowAnswers(({ walk }) => {
  test("so they do when who they are is the slowest answer", () => walk("&meLatency=1500"));
});

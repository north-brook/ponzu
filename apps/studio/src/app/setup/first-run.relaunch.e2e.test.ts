/*
 * Between the guided steps, with slow answers (slow-answers.e2e-lib.ts): a relaunch part way
 * through setup, or past it, opens on where the person belongs.
 */
import { slowAnswers } from "./slow-answers.e2e-lib.ts";

slowAnswers(({ relaunch }) => {
  relaunch("where", "Where do you design?", "where");
  relaunch("claude", "Connect Claude", "claude");
  relaunch("iphone", "Get Ponzu on your iPhone", "iphone");
  relaunch("returning", "What do you want to design?", "create");
});

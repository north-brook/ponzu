import { describe, expect, test } from "bun:test";
import { EXCERPT_WORDS, excerpt } from "./story.ts";

describe("excerpt", () => {
  test("a short comment shows whole", () => {
    const t = "Make the price more prominent. My eye skips it.";
    expect(excerpt(t)).toBe(t);
  });

  test("a long comment keeps its ask and cuts from the person's own words", () => {
    const t =
      "Love the ear, but the mark has too much going on: the crumb dots, the hatching and the highlight will turn to mush at sticker size. Can we simplify it so it holds up at 16px?";
    const out = excerpt(t);
    expect(out).toBe(
      "Love the ear, but the mark has too much going on… Can we simplify it so it holds up at 16px?",
    );
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(EXCERPT_WORDS);
  });

  test("whole sentences stay when they fit", () => {
    const t =
      "There’s a big dead gap between the subhead and the button on mobile. Feels unfinished. Maybe show the plans or the steps here?";
    expect(excerpt(t)).toBe(
      "There’s a big dead gap between the subhead and the button on mobile… Maybe show the plans or the steps here?",
    );
  });
});

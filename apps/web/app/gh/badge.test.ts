import { expect, test } from "bun:test";
import { badgeLabel, badgeSvg } from "./badge.ts";

test("a badge is labelled by its design, or 'open in' without one", () => {
  expect(badgeLabel("Kettle")).toBe("Kettle");
  expect(badgeLabel("  design\n system ")).toBe("design system");
  expect(badgeLabel(null)).toBe("open in");
  expect(badgeLabel("   ")).toBe("open in");
  expect(badgeLabel("x".repeat(80))).toHaveLength(40);
});

test("the badge grows with its label and escapes it", () => {
  const short = badgeSvg("app");
  const long = badgeSvg("design system");
  const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
  expect(width(long)).toBeGreaterThan(width(short));
  expect(badgeSvg('<a href="x">')).not.toContain("<a ");
  expect(badgeSvg("Kettle")).toContain('aria-label="Kettle | Ponzu"');
});

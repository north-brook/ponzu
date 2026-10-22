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

test("the slice sits with Ponzu, in ink on the yuzu half", () => {
  const svg = badgeSvg("app");
  const left = Number(/<rect width="(\d+)" height="20" fill="#1c1c1c"/.exec(svg)?.[1]);
  const slice = /<g transform="translate\((\d+) 4\)[^>]*fill="(#[0-9a-f]+)"/.exec(svg);
  expect(Number(slice?.[1])).toBe(left + 5);
  expect(slice?.[2]).toBe("#111110");
  // The label is plain text from the left edge, with no mark before it.
  expect(svg).toContain('<text x="6" y="14" fill="#fff">app</text>');
});

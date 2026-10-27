import { expect, spyOn, test } from "bun:test";
import type { Idea } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import { ARRIVAL_STAGGER_MS, arrivalOf, land } from "@/lib/suggestions";
import { IdeaBody, SuggestionCard, Thinking } from "./suggested.tsx";

const idea = (name: string): Idea => ({
  name,
  project: "/Users/me/code/seekle",
  projectId: "github.com/me/seekle",
  projectName: "seekle",
  card: "Rebuild every screen in apps/native with their states, on one page.",
  prompt: `In ~/code/seekle, put this in a new Ponzu design called “${name}”: rebuild every screen.`,
  found: 0,
});

test("a card holds what the design would show, with its name and project where a design's go", () => {
  const html = renderToStaticMarkup(
    <SuggestionCard idea={idea("Every Seekle screen")} onPick={() => {}} />,
  );
  expect(html).toContain("border-dashed");
  expect(html).toContain("aspect-[16/11]");
  expect(html).toContain("Rebuild every screen in apps/native");
  expect(html).toContain("Every Seekle screen");
  expect(html).toContain(">seekle<");
  // No branch and no time.
  expect(html).not.toMatch(/\bago\b|branch/);
});

test("ideas are timed from when they landed, together ones one after another", () => {
  // What the server had when the studio first asked was there from the start.
  land([idea("Old")]);
  expect(arrivalOf(idea("Old"))).toBe(0);
  land([idea("First"), idea("Second"), idea("Old")], 1_000);
  expect(arrivalOf(idea("First"))).toBe(1_000);
  expect(arrivalOf(idea("Second"))).toBe(1_000 + ARRIVAL_STAGGER_MS);
  expect(arrivalOf(idea("Old"))).toBe(0);
  // The same every answer and render after.
  land([idea("First")], 90_000);
  expect(arrivalOf({ ...idea("first"), card: "changed" })).toBe(1_000);
});

test("a card first shown after its idea landed traces in only if it's still arriving", () => {
  const card = (name: string) =>
    renderToStaticMarkup(<SuggestionCard idea={idea(name)} onPick={() => {}} />);
  const clock = spyOn(performance, "now").mockReturnValue(500_000);
  try {
    // Landed a minute ago, while Recent was open or its project filtered out: already arrived.
    land([idea("While away")], 440_000);
    expect(card("While away")).not.toContain("pz-rain");
    land([idea("Just now")]);
    expect(card("Just now")).toContain("pz-rain");
  } finally {
    clock.mockRestore();
  }
});

test("thinking is the rain alone", () => {
  const html = renderToStaticMarkup(<Thinking />);
  expect(html).toContain("pz-rain");
  expect(html).not.toMatch(/>[A-Za-z]/);
});

test("the dialog has the name, the project, the whole prompt and one Copy prompt", () => {
  const picked = idea("Every Seekle screen");
  const html = (copied: boolean) =>
    renderToStaticMarkup(
      <Dialog open>
        <IdeaBody idea={picked} copied={copied} onCopy={() => {}} />
      </Dialog>,
    );
  expect(html(false)).toContain("Every Seekle screen");
  expect(html(false)).toContain(">seekle<");
  expect(html(false)).toContain(
    "In ~/code/seekle, put this in a new Ponzu design called “Every Seekle screen”: rebuild every screen.",
  );
  expect(html(false).match(/<button/g)).toHaveLength(1);
  expect(html(false)).toContain("Copy prompt");
  expect(html(true)).toContain("Copied");
});

import { expect, test } from "bun:test";
import type { Idea } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import { ARRIVAL_STAGGER_MS, arrivalOf } from "@/lib/suggestions";
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

test("ideas landing together trace in one after another, each at the same time every render", () => {
  const a = arrivalOf(idea("First"));
  const b = arrivalOf(idea("Second"));
  expect(b - a).toBeGreaterThanOrEqual(ARRIVAL_STAGGER_MS);
  expect(arrivalOf(idea("First"))).toBe(a);
  expect(arrivalOf({ ...idea("first"), card: "changed" })).toBe(a);
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

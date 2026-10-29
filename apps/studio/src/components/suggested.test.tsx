import { expect, spyOn, test } from "bun:test";
import type { Idea } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import { ARRIVAL_STAGGER_MS, arrivalOf, land } from "@/lib/suggestions";
import { IdeaBody, LookingCard, SuggestionCard, Thinking } from "./suggested.tsx";

const idea = (name: string): Idea => ({
  name,
  project: "/Users/me/code/seekle",
  projectId: "github.com/me/seekle",
  projectName: "seekle",
  prompt: `In ~/code/seekle, make a new Ponzu design called “${name}”. Rebuild every screen.`,
  found: 0,
});

test("a card holds the prompt, with its name and project where a design's go", () => {
  const html = renderToStaticMarkup(
    <SuggestionCard idea={idea("Every Seekle screen")} onPick={() => {}} />,
  );
  expect(html).toContain("border-dashed");
  expect(html).toContain("aspect-[16/11]");
  expect(html).toContain(
    "make a new Ponzu design called “Every Seekle screen”. Rebuild every screen.",
  );
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
  expect(arrivalOf({ ...idea("first"), prompt: "changed" })).toBe(1_000);
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
    "In ~/code/seekle, make a new Ponzu design called “Every Seekle screen”. Rebuild every screen.",
  );
  expect(html(false).match(/<button/g)).toHaveLength(1);
  expect(html(false)).toContain("Copy prompt");
  expect(html(true)).toContain("Copied");
});

test("a project being looked around has a card of its own, rain where a name goes", () => {
  const html = renderToStaticMarkup(
    <LookingCard
      at={{
        project: "/Users/me/code/seekle",
        projectId: "github.com/me/seekle",
        projectName: "seekle",
        folder: "~/code/seekle",
      }}
    />,
  );
  expect(html).toContain("Looking around ~/code/seekle…");
  expect(html).toContain("pz-rain");
  expect(html).toContain(">seekle<");
});

test("until its prompt is written, a card shows what the agent reads, the latest brightest", () => {
  const writing: Idea = {
    ...idea("Every Seekle screen"),
    prompt: "",
    steps: [
      { verb: "find", what: "apps/native/**/*.tsx" },
      { verb: "search", what: "trio" },
      { verb: "read", what: "app/home.tsx" },
    ],
  };
  const html = renderToStaticMarkup(<SuggestionCard idea={writing} onPick={() => {}} />);
  expect(html).toContain("Reading the code…");
  expect(html).toContain("Finding</span>");
  expect(html).toContain("“trio”");
  expect(html.match(/text-foreground\/80/g)).toHaveLength(1);
  expect(html.indexOf("app/home.tsx")).toBeGreaterThan(html.indexOf("text-foreground/80"));
  expect(html).toContain("Every Seekle screen");
});

test("picked before its prompt is written, the dialog shows the reading and Copy waits", () => {
  const writing: Idea = {
    ...idea("Every Seekle screen"),
    prompt: "",
    steps: [{ verb: "read", what: "app/home.tsx" }],
  };
  const html = renderToStaticMarkup(
    <Dialog open>
      <IdeaBody idea={writing} agent="claude" copied={false} onCopy={() => {}} />
    </Dialog>,
  );
  expect(html).toContain("Claude Code is reading seekle to write this prompt…");
  expect(html).toContain("app/home.tsx");
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).toContain("Copy prompt works once it’s written.");
});

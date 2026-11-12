import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { reportedModels } from "../gallery/fixtures.ts";
import { EFFORTS, type Effort, effortFor, effortsOf } from "../model.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { ModelPicker } from "./model-picker.tsx";

/*
 * The picker on a list the person's Claude account reported, unlike the hand-kept one: a model
 * Ponzu has never heard of, no Fable, and a model with fewer efforts.
 */

const trigger = (model: string, effort: Effort) =>
  renderToStaticMarkup(
    <TipProvider>
      <ModelPicker
        models={reportedModels}
        efforts={EFFORTS}
        model={model}
        effort={effort}
        onChange={() => {}}
      />
    </TipProvider>,
  );

test("a model Ponzu has never heard of shows under the name the list gives it", () => {
  expect(trigger("claude-opus-6", "high")).toContain('aria-label="Model: Opus 6, effort High"');
});

test("the trigger says the model and its effort at 14, beside a 14 mark", () => {
  const html = trigger("claude-opus-5-5", "high");
  expect(html).toContain('aria-label="Model: Opus 5.5, effort High"');
  expect(html).toContain("text-14");
  expect(html).toMatch(/<svg[^>]*width="14"/);
  expect(html).toContain(">High</span>");
});

test("a model that takes no effort shows its name alone, and says no effort", () => {
  const html = trigger("claude-haiku-4-5", "medium");
  expect(html).toContain('aria-label="Model: Haiku 4.5"');
  expect(html).not.toContain(">Medium</span>");
});

test("each model lists its own efforts, one that says nothing lists them all, one that takes none none", () => {
  expect(effortsOf(reportedModels, EFFORTS, "claude-haiku-5-5")).toEqual(["low", "medium"]);
  expect(effortsOf([{ id: "m", label: "M" }], EFFORTS, "m")).toEqual(EFFORTS);
  expect(effortsOf(reportedModels, EFFORTS, "claude-haiku-4-5")).toEqual([]);
  // Changing to it keeps the effort carried, which the API lets by and never runs.
  expect(effortFor(reportedModels, EFFORTS, "claude-haiku-4-5", "high")).toBe("high");
});

test("changing model keeps the effort it takes, else medium, else its first", () => {
  expect(effortFor(reportedModels, EFFORTS, "claude-haiku-5-5", "low")).toBe("low");
  expect(effortFor(reportedModels, EFFORTS, "claude-haiku-5-5", "max")).toBe("medium");
  const highOnly = [{ id: "h", label: "H", efforts: ["high", "max"] as Effort[] }];
  expect(effortFor(highOnly, EFFORTS, "h", "low")).toBe("high");
});

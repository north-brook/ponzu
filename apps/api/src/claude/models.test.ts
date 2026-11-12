import { expect, test } from "bun:test";
import type { ClaudeModelReport } from "@ponzu/db";
import recorded from "@ponzu/runner/fixtures/supported-models.api-key.json";
import { reportedModels } from "@ponzu/runner/models";
import type { Effort } from "@ponzu/runner/protocol";
import {
  CLAUDE_MODELS,
  checkOffered,
  effortOrDefault,
  modelOrDefault,
  offeredEfforts,
  offeredModels,
  offerFor,
} from "./models.ts";

/*
 * What an account is offered, from what the pinned Claude Code really answered
 * `supportedModels()` with for the development API key (recorded by
 * apps/runner/scripts/supported-models.ts), and from answers it could give another account.
 */

/** The recorded answer, as the runner reports it. */
const REPORTED = reportedModels(recorded.models as Parameters<typeof reportedModels>[0]);
const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const entry = (over: Partial<ClaudeModelReport> & { value: string }): ClaudeModelReport => ({
  resolvedModel: null,
  displayName: over.value,
  description: "",
  efforts: null,
  ...over,
});

test("the recorded answer offers the four models Ponzu knows, by full id, named and ordered as it does", () => {
  const offer = offeredModels(REPORTED);
  expect(offer.reported).toBe(true);
  // "default" means whatever Claude Code runs by default, and is Opus 5.5 again: not a row.
  expect(offer.models).toEqual([
    { id: "claude-fable-5-2", label: "Fable 5.2", efforts: ALL },
    { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ALL },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ALL },
    { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ALL },
  ]);
  expect(offer.defaultModel).toBe("claude-opus-5-5");
});

test("a model Ponzu has never heard of is offered after the known ones, under Claude Code's name with its version", () => {
  const offer = offeredModels([
    entry({
      value: "opus",
      resolvedModel: "claude-opus-6",
      displayName: "Opus",
      description: "Opus 6 · Best for everyday, complex tasks · $4/$20 per Mtok",
      efforts: ["low", "high"],
    }),
    ...REPORTED.filter((m) => m.value === "haiku"),
    entry({ value: "claude-mystery-1", displayName: "Mystery", description: "Something new" }),
  ]);
  expect(offer.models).toEqual([
    { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ALL },
    { id: "claude-opus-6", label: "Opus 6", efforts: ["low", "high"] },
    // No resolved id: it runs on what Claude Code takes; no effort levels said: all of them.
    { id: "claude-mystery-1", label: "Mystery", efforts: ALL },
  ]);
});

test("a model the account is not offered is not offered, and the default gives way", () => {
  const withoutOpus = REPORTED.filter((m) => m.resolvedModel !== "claude-opus-5-5");
  const offer = offeredModels(withoutOpus);
  expect(offer.models.map((m) => m.id)).toEqual([
    "claude-fable-5-2",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);
  // No Opus 5.5 and no "default" entry: the first offered.
  expect(offer.defaultModel).toBe("claude-fable-5-2");
  expect(modelOrDefault(offer, "claude-opus-5-5")).toBe("claude-fable-5-2");
  expect(modelOrDefault(offer, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
});

test("without Opus 5.5, what Claude Code calls its default is the default", () => {
  const offer = offeredModels([
    entry({ value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default" }),
    entry({ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" }),
    entry({ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" }),
  ]);
  expect(offer.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(offer.defaultModel).toBe("claude-sonnet-5-5");
});

test("a default no other entry offers is offered once, under its id", () => {
  const offer = offeredModels([
    entry({
      value: "default",
      resolvedModel: "claude-new-7",
      displayName: "Default (recommended)",
    }),
  ]);
  expect(offer.models).toEqual([{ id: "claude-new-7", label: "claude-new-7", efforts: ALL }]);
  expect(offer.defaultModel).toBe("claude-new-7");
});

test("an account nobody has reported for, or none at all, is offered the hand-kept list", () => {
  for (const offer of [
    offeredModels(null),
    offeredModels([]),
    // Only "default", resolving to nothing: nothing to offer.
    offeredModels([entry({ value: "default" })]),
    offerFor(null),
    offerFor({ status: "connected", models: null }),
    offerFor({ status: "revoked", models: REPORTED.slice(0, 2) }),
  ]) {
    expect(offer.models).toEqual([...CLAUDE_MODELS]);
    expect(offer.reported).toBe(false);
    expect(offer.defaultModel).toBe("claude-opus-5-5");
  }
});

test("efforts: the chosen one while the model takes it, else medium, else its first, else none", () => {
  const offer = offeredModels([
    entry({ value: "a", resolvedModel: "claude-a", efforts: ["low", "medium", "high"] }),
    entry({ value: "b", resolvedModel: "claude-b", efforts: ["high", "max"] }),
    entry({ value: "c", resolvedModel: "claude-c", efforts: [] }),
  ]);
  expect(effortOrDefault(offer, "claude-a", "high")).toBe("high");
  expect(effortOrDefault(offer, "claude-a", "max")).toBe("medium");
  expect(effortOrDefault(offer, "claude-b", "low")).toBe("high");
  expect(effortOrDefault(offer, "claude-c", "low")).toBeNull();
  expect(offeredEfforts(offer)).toEqual(["low", "medium", "high", "max"]);
});

test("a choice the account does not offer is refused", () => {
  const offer = offeredModels(REPORTED.filter((m) => m.value !== "fable"));
  expect(() => checkOffered(offer, "claude-opus-5-5", "max")).not.toThrow();
  expect(() => checkOffered(offer, "claude-fable-5-2", undefined)).toThrow(
    "Your Claude account doesn't offer that model.",
  );
  // An alias is not a model the picker offers: the full id is.
  expect(() => checkOffered(offer, "opus", undefined)).toThrow();
  const fewer = offeredModels([
    entry({ value: "h", resolvedModel: "claude-h", displayName: "H", efforts: ["low"] }),
  ]);
  expect(() => checkOffered(fewer, "claude-h", "max")).toThrow("H doesn't take that effort");
});

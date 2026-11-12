import type { ClaudeAccount, ClaudeModelReport } from "@ponzu/db";
import type { Effort } from "@ponzu/runner/protocol";
import { ApiError } from "../http/errors.ts";

/*
 * What a design's agent may run on (docs/cloud.md, "Models"). A runner reports what Claude Code
 * offers the account it runs as (the Agent SDK's `supportedModels()`), and that is what the
 * account is offered: a model Anthropic ships appears once the sandbox image's Claude Code knows
 * it, with no Ponzu release. The list below is what an account nobody has reported for yet is
 * offered, and where an id matches, the name and the order the apps show it under. The Claude
 * Code workflow's pull request names any model its release notes mention that this list lacks.
 */

export interface ClaudeModel {
  /** The full model id a turn runs on: `claude-opus-5-5`. */
  id: string;
  label: string;
  /** The effort levels it takes, in order; empty when it takes none. */
  efforts: Effort[];
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies Effort[];

/** The hand-kept list: the fallback, and the names and order of the models it knows. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", efforts: [...EFFORTS] },
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: [...EFFORTS] },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: [...EFFORTS] },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: [...EFFORTS] },
];

/** What a person's new designs run on until they choose otherwise, when their account offers it. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";

/** What Claude Code calls "whatever the default is": never a row of its own. */
const DEFAULT_ALIAS = "default";

/** What an account is offered, and what runs when nothing offered was chosen. */
export interface ModelOffer {
  /** In the order the apps list them, never empty. */
  models: ClaudeModel[];
  /** What runs on this account when nothing it offers was chosen. */
  defaultModel: string;
  /** Whether `models` is what a runner reported, rather than the hand-kept list. */
  reported: boolean;
}

/**
 * A report's entries as what the account is offered. Each entry runs on the full id Claude Code
 * resolves it to (`opus` runs as `claude-opus-5-5`), so a saved choice keeps meaning one model
 * whatever the alias later points at; an entry Claude Code resolves to nothing runs on what it
 * says. `default` is left out, and so is a second entry for an id already offered. A model the
 * hand-kept list knows takes its name and place; any other comes after them, in the order Claude
 * Code gave, under the name Claude Code gives it.
 */
export function offeredModels(report: readonly ClaudeModelReport[] | null): ModelOffer {
  const rows = new Map<string, ClaudeModel>();
  let defaultTarget: string | null = null;
  for (const entry of report ?? []) {
    const id = entry.resolvedModel ?? entry.value;
    if (entry.value === DEFAULT_ALIAS) {
      defaultTarget = entry.resolvedModel;
      continue;
    }
    if (!id || rows.has(id)) continue;
    rows.set(id, {
      id,
      label: labelOf(entry),
      efforts: effortsOf(entry.efforts),
    });
  }
  // The default's target, when no other entry offers it, is still a model it may run on.
  if (defaultTarget && !rows.has(defaultTarget)) {
    rows.set(defaultTarget, {
      id: defaultTarget,
      label: defaultTarget,
      efforts: effortsOf(report?.find((e) => e.value === DEFAULT_ALIAS)?.efforts ?? null),
    });
  }
  if (rows.size === 0) {
    return { models: [...CLAUDE_MODELS], defaultModel: DEFAULT_MODEL, reported: false };
  }
  const known = CLAUDE_MODELS.flatMap((model) => {
    const row = rows.get(model.id);
    return row ? [{ ...row, label: model.label }] : [];
  });
  const unknown = [...rows.values()].filter((row) => !CLAUDE_MODELS.some((m) => m.id === row.id));
  const models = [...known, ...unknown];
  const ids = models.map((model) => model.id);
  const defaultModel = ids.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : defaultTarget && ids.includes(defaultTarget)
      ? defaultTarget
      : ids[0]!;
  return { models, defaultModel, reported: true };
}

/** What `account` is offered: its runner's last report, or the hand-kept list until there is one. */
export function offerFor(account: Pick<ClaudeAccount, "models" | "status"> | null): ModelOffer {
  return offeredModels(account && account.status !== "revoked" ? account.models : null);
}

/** A saved choice the account still offers, or what runs in its place. */
export function modelOrDefault(offer: ModelOffer, model: string | null): string {
  return model && offer.models.some((m) => m.id === model) ? model : offer.defaultModel;
}

/**
 * A saved effort that `model` takes, or the default effort if it takes that, or its first. Null
 * when the model takes none: Claude Code then runs it as it does.
 */
export function effortOrDefault(
  offer: ModelOffer,
  model: string,
  effort: string | null,
): Effort | null {
  const efforts = offer.models.find((m) => m.id === model)?.efforts ?? [...EFFORTS];
  if (effort && (efforts as string[]).includes(effort)) return effort as Effort;
  if (efforts.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  return efforts[0] ?? null;
}

/**
 * Refuse a choice the account does not offer: a model it does not, or an effort that model does
 * not take. Answered 400 `model_not_offered`. An effort sent with a model that takes none is not
 * refused: `/v1/claude/defaults` shows the default effort for such a model, so the apps send it
 * back, and the model is never run with one (`effortOrDefault` gives null for it).
 */
export function checkOffered(offer: ModelOffer, model: string, effort: string | undefined): void {
  const offered = offer.models.find((m) => m.id === model);
  if (!offered) {
    throw new ApiError(400, "model_not_offered", "Your Claude account doesn't offer that model.");
  }
  if (
    effort !== undefined &&
    offered.efforts.length > 0 &&
    !(offered.efforts as string[]).includes(effort)
  ) {
    throw new ApiError(
      400,
      "model_not_offered",
      `${offered.label} doesn't take that effort on your Claude account.`,
    );
  }
}

/** Every effort any offered model takes, in order: what the apps list when a model says nothing. */
export function offeredEfforts(offer: ModelOffer): Effort[] {
  return EFFORTS.filter((effort) => offer.models.some((m) => m.efforts.includes(effort)));
}

/**
 * Claude Code's name for an alias row is the family alone (`Opus`); its description begins with
 * the version it runs now (`Opus 5.5 · Best for…`). That beginning is the name when it is the
 * family's with a version after it, so a model this list has never heard of still shows as
 * `Opus 6` rather than `Opus`.
 */
function labelOf(entry: ClaudeModelReport): string {
  const name = oneLine(entry.displayName) || entry.resolvedModel || entry.value;
  const lead = oneLine(entry.description.split(" · ")[0] ?? "");
  const label =
    lead.startsWith(`${name} `) && /^[\d.]+$/.test(lead.slice(name.length + 1)) ? lead : name;
  // A menu row, not a paragraph: whatever Claude Code says, the apps show a short name.
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** The longest name a row is shown under. */
const MAX_LABEL = 40;

/** `text` on one line: no control characters, and each run of white space one space. */
function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function effortsOf(efforts: ClaudeModelReport["efforts"]): Effort[] {
  if (efforts === null) return [...EFFORTS];
  return EFFORTS.filter((effort) => efforts.includes(effort));
}

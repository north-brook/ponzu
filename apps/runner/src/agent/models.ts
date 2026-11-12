import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, ReportedModel } from "../api/protocol.ts";

/*
 * What Claude Code offers the account it runs as, as the runner reports it (docs/cloud.md,
 * "Models"): the Agent SDK's `supportedModels()`, which Claude Code answers with the session's
 * start, kept as it said it. The API decides what becomes a row in the picker, so a change to
 * that needs no new runner.
 */

/** As many models as a report carries, and as long as each text in it may be: the API's caps. */
export const MAX_REPORTED_MODELS = 50;
const MAX_TEXT = 200;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Whether `id` can be sent as a model: a clipped id would name a model that does not exist. */
const sendable = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_TEXT;

/**
 * What `supportedModels()` answered, as the runner reports it. An entry whose id is too long to
 * send is left out, never clipped; the API refuses one the same way.
 */
export function reportedModels(models: readonly ModelInfo[]): ReportedModel[] {
  return models
    .filter(
      (model) => sendable(model.value) && (!model.resolvedModel || sendable(model.resolvedModel)),
    )
    .slice(0, MAX_REPORTED_MODELS)
    .map((model) => ({
      value: model.value,
      resolvedModel: model.resolvedModel || null,
      displayName: (model.displayName ?? "").slice(0, MAX_TEXT),
      description: (model.description ?? "").slice(0, MAX_TEXT * 2),
      efforts:
        model.supportsEffort === false
          ? []
          : model.supportedEffortLevels
            ? EFFORTS.filter((effort) => model.supportedEffortLevels!.includes(effort))
            : null,
    }));
}

/** Whether two reports say the same: in the same order, the same entries. */
export function sameModels(a: readonly ReportedModel[], b: readonly ReportedModel[]): boolean {
  return JSON.stringify(a.map(canonical)) === JSON.stringify(b.map(canonical));
}

function canonical(model: ReportedModel) {
  return [model.value, model.resolvedModel, model.displayName, model.description, model.efforts];
}

import type { Effort } from "@ponzu/runner/protocol";

/*
 * What a design's agent may run on: the models the sandbox image's Claude Code takes, and the
 * effort levels. They move with the image's Claude Code (apps/runner/image pins it), so a new
 * model is added here when the image that knows it is baked.
 */

export interface ClaudeModel {
  id: string;
  label: string;
}

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies Effort[];

/** What a person's new designs run on until they choose otherwise. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "high";

export const MODEL_IDS = CLAUDE_MODELS.map((model) => model.id) as [string, ...string[]];

/** A saved choice that the runtime still offers, or the default. */
export function modelOrDefault(model: string | null): string {
  return model && MODEL_IDS.includes(model) ? model : DEFAULT_MODEL;
}

export function effortOrDefault(effort: string | null): Effort {
  return effort && (EFFORTS as readonly string[]).includes(effort)
    ? (effort as Effort)
    : DEFAULT_EFFORT;
}

import { createHash } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { Meter } from "./meter.ts";

/*
 * A judge: a model asked to grade something against a written rubric, answering in a
 * structured form with its reason before its verdict. It goes through the AI SDK the way the
 * product's own model calls do (`generateText` with `Output.object`), and every call is metered.
 * The judges are a stronger model than what they judge: Claude Opus 5.5 offline.
 */

/** The offline judges' model. */
export const JUDGE_MODEL = "claude-opus-5-5";

export type Model = Exclude<LanguageModel, string>;

/** Claude models on Anthropic's API with `apiKey`, never a base URL from the environment. */
export function anthropicModels(apiKey: string): (id: string) => Model {
  const anthropic = createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" });
  return (id) => anthropic(id);
}

export interface JudgeRequest<T> {
  /** What is being judged, for the meter: `ideas`, `thread`. */
  label: string;
  /** The rubric. Only what Ponzu wrote. */
  instructions: string;
  /** What is judged, fenced as data. */
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
}

export interface Judge {
  /** The model id, for the report and the version. */
  readonly model: string;
  ask<T>(request: JudgeRequest<T>): Promise<T>;
}

export class JudgeError extends Error {
  override name = "JudgeError";
}

const MAX_OUTPUT = 8_000;

export function createJudge(model: Model, meter: Meter): Judge {
  const id = model.modelId;
  return {
    model: id,
    async ask<T>({
      label,
      instructions,
      prompt,
      schema,
      maxOutputTokens = MAX_OUTPUT,
    }: JudgeRequest<T>) {
      meter.reserve(id, { maxOutputTokens, inputChars: instructions.length + prompt.length });
      try {
        const result = await generateText({
          model,
          instructions,
          prompt,
          output: Output.object({ schema }),
          maxOutputTokens,
          // The reason is written before each verdict, so little thinking is needed first.
          reasoning: "low",
          maxRetries: 2,
        });
        meter.record(id, `judge:${label}`, {
          input: result.totalUsage.inputTokens ?? 0,
          output: result.totalUsage.outputTokens ?? 0,
        });
        return result.output as T;
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          meter.record(id, `judge:${label}`, {
            input: error.usage?.inputTokens ?? 0,
            output: error.usage?.outputTokens ?? 0,
          });
          throw new JudgeError(
            `the ${label} judge gave no answer in shape (${error.finishReason})`,
          );
        }
        throw error;
      }
    },
  };
}

/**
 * A judge's version: its model, its prompt and the shape of its answer. A calibration is recorded
 * under it, and a suite will not run a judge whose version has no passing calibration.
 */
export function judgeVersion(model: string, instructions: string, schema: z.ZodType): string {
  return createHash("sha256")
    .update(`${model}\n${instructions}\n${JSON.stringify(z.toJSONSchema(schema))}`)
    .digest("hex")
    .slice(0, 12);
}

/** Text from outside, inside a fence it cannot close: every `<` and `>` replaced. */
export function fenced(tag: string, text: string): string {
  return `<${tag}>\n${text.replaceAll("<", "‹").replaceAll(">", "›")}\n</${tag}>`;
}

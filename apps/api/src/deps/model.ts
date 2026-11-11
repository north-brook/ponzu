import { createAnthropic } from "@ai-sdk/anthropic";
import {
  APICallError,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
} from "ai";
import type { z } from "zod";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";

/*
 * A small fast Claude model, paid for by Ponzu, for the small things the API itself asks a
 * model: never a person's work. A design's agent runs on the person's own Claude plan in its
 * sandbox and never comes through here. The one caller today is `ideas/`.
 *
 * The call is the AI SDK's `generateText` with a structured output. It reaches Claude through
 * the Anthropic provider on Ponzu's own key (`ANTHROPIC_API_KEY`), not the Vercel AI Gateway:
 * the key already exists on every environment, local development and the scripts need no
 * Vercel login, and the requests go through the API's own `fetch`, where a test can see them.
 * To go through the gateway instead, see `createClaude`: it is one line.
 */

/** One request for an answer in the shape of `schema`. */
export interface StructuredRequest<T> {
  /** The instructions. Only what Ponzu wrote goes here. */
  instructions: string;
  /** The one user turn: where anything from outside goes, fenced as data. */
  prompt: string;
  /** What the answer must be: sent as the structured output's JSON schema, and checked on return. */
  schema: z.ZodType<T>;
  /** The most it may write, thinking included. */
  maxTokens: number;
  /** How much it thinks first: the AI SDK's portable `reasoning`, Anthropic's `effort`. */
  effort: "low" | "medium" | "high";
  /** Gives up the request when it aborts: the caller's timeout. */
  signal?: AbortSignal;
}

export interface StructuredAnswer<T> {
  /** The answer, or null when it gave none in that shape (or refused, or ran out of room). */
  output: T | null;
  /** Why it stopped, as the AI SDK says it: `stop`, `length`, `content-filter`. */
  finishReason: string | null;
  /** What it cost, in tokens. */
  usage: { input: number; output: number };
}

export interface Model {
  /** The model it asks, for the logs: `claude-haiku-5-5`. */
  readonly id: string;
  /**
   * Asks once. Getting no answer at all (the API down, out of rate limit, the key refused, the
   * signal aborted, the timeout) throws an `UpstreamError` from `model`; an answer that is not
   * in the shape asked for is `output: null`, with what it cost.
   */
  structured<T>(request: StructuredRequest<T>): Promise<StructuredAnswer<T>>;
}

/** Claude Haiku 5.5, by Anthropic's id. On the AI Gateway it is `anthropic/claude-haiku-5.5`. */
export const CLAUDE_HAIKU = "claude-haiku-5-5";

/** How long one request may take, retry included, when the caller's signal has not ended it. */
const TIMEOUT_MS = 30_000;

/** The real thing: Claude Haiku on Ponzu's Anthropic key, over the API's `fetch`. */
export function createClaude({ apiKey, fetch }: { apiKey: string; fetch: Fetch }): Model {
  const anthropic = createAnthropic({
    apiKey,
    // Said outright: the provider otherwise reads ANTHROPIC_BASE_URL from the environment,
    // which would send Ponzu's requests, and its key, elsewhere.
    baseURL: "https://api.anthropic.com/v1",
    fetch: fetch as typeof globalThis.fetch,
  });
  return createModel(anthropic(CLAUDE_HAIKU));
  // Through the Vercel AI Gateway instead (AI_GATEWAY_API_KEY, or the deployment's OIDC token
  // once the gateway is enabled on the project), the line is:
  // return createModel("anthropic/claude-haiku-5.5");
}

/** Any AI SDK language model behind the `Model` interface. */
export function createModel(model: LanguageModel): Model {
  const id = typeof model === "string" ? model : model.modelId;
  return {
    id,
    async structured<T>({
      instructions,
      prompt,
      schema,
      maxTokens,
      effort,
      signal,
    }: StructuredRequest<T>): Promise<StructuredAnswer<T>> {
      try {
        const result = await generateText({
          model,
          instructions,
          prompt,
          // Sent as the answer's JSON schema (Anthropic's structured outputs), and checked on
          // return: an answer that does not fit throws `NoObjectGeneratedError`, below.
          output: Output.object({ schema }),
          maxOutputTokens: maxTokens,
          reasoning: effort,
          // One more try for a 429, a 5xx or a dropped connection; the timeout bounds both.
          maxRetries: 1,
          timeout: TIMEOUT_MS,
          ...(signal ? { abortSignal: signal } : {}),
        });
        return {
          output: result.output,
          finishReason: result.finishReason,
          usage: tokens(result.usage),
        };
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          return {
            output: null,
            finishReason: error.finishReason ?? null,
            usage: tokens(error.usage),
          };
        }
        if (NoOutputGeneratedError.isInstance(error)) {
          return { output: null, finishReason: null, usage: { input: 0, output: 0 } };
        }
        const upstream = noAnswer(error);
        if (upstream) throw upstream;
        throw error;
      }
    },
  };
}

function tokens(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 };
}

/** The `UpstreamError` for a call that got no answer, or null for an error that is a bug. */
function noAnswer(error: unknown): UpstreamError | null {
  // After its retries the SDK throws a `RetryError` around the last failure.
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(last)) {
    const status = last.statusCode;
    return new UpstreamError("model", `the model call failed (${status ?? "no answer"})`, {
      ...(status === undefined ? {} : { status }),
      cause: error,
    });
  }
  if (RetryError.isInstance(error) || isAbort(error)) {
    return new UpstreamError("model", "the model call failed (no answer)", { cause: error });
  }
  return null;
}

/** An abort or a timeout, or an error caused by one. */
function isAbort(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    current = current.cause;
  }
  return false;
}

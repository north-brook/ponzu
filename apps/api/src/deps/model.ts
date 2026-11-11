import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";

/*
 * A Claude model on the Anthropic API, paid for with Ponzu's own key (`ANTHROPIC_API_KEY`): for
 * the small things the API itself asks a model, never a person's work. A design's agent runs on
 * the person's own Claude plan in its sandbox and never comes through here. The one caller
 * today is `ideas/`.
 */

/** One request for an answer in the shape of `schema`. */
export interface StructuredRequest<T> {
  /** The exact model id, like `claude-haiku-5-5`. */
  model: string;
  /** The instructions. Only what Ponzu wrote goes here. */
  system: string;
  /** The one user turn: where anything from outside goes, fenced as data. */
  prompt: string;
  /** What the answer must be: sent as the structured output's JSON schema, and checked on return. */
  schema: z.ZodType<T>;
  /** The most it may write, thinking included. */
  maxTokens: number;
  effort: "low" | "medium" | "high";
  /** Gives up the request when it aborts: the caller's timeout. */
  signal?: AbortSignal;
}

export interface StructuredAnswer<T> {
  /** The answer, or null when it gave none in that shape (or refused, or ran out of room). */
  output: T | null;
  /** Why it stopped: `end_turn`, `max_tokens`, `refusal`. */
  stopReason: string | null;
  /** What it cost, in tokens. */
  usage: { input: number; output: number };
}

export interface Model {
  /**
   * Asks once. Getting no answer at all (the API down, out of rate limit, the key refused, the
   * signal aborted) throws an `UpstreamError` from `anthropic`; an answer that is not in the
   * shape asked for is `output: null`, with what it cost.
   */
  structured<T>(request: StructuredRequest<T>): Promise<StructuredAnswer<T>>;
}

/** How long one request may take by the SDK's own timer, when the caller's signal has not ended it. */
const TIMEOUT_MS = 30_000;

/** The real thing: the official SDK, over the API's `fetch`. */
export function createAnthropicModel({ apiKey, fetch }: { apiKey: string; fetch: Fetch }): Model {
  const client = new Anthropic({
    apiKey,
    // Said outright: the SDK otherwise reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from
    // the environment itself, and either would send Ponzu's requests, or its key, elsewhere.
    baseURL: "https://api.anthropic.com",
    authToken: null,
    webhookKey: null,
    fetch: fetch as typeof globalThis.fetch,
    timeout: TIMEOUT_MS,
    // One more try for a 429, a 5xx or a dropped connection; the caller's timeout bounds both.
    maxRetries: 1,
  });

  return {
    async structured<T>({
      model,
      system,
      prompt,
      schema,
      maxTokens,
      effort,
      signal,
    }: StructuredRequest<T>): Promise<StructuredAnswer<T>> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: prompt }],
            // The schema goes to the API as the answer's JSON schema, and the answer is checked
            // against it here, so what it cost is known even when it does not fit.
            output_config: { effort, format: zodOutputFormat(schema) },
          },
          { signal },
        );
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          const status = error.status;
          throw new UpstreamError("anthropic", `the model call failed (${status ?? "no answer"})`, {
            ...(status === undefined ? {} : { status }),
            cause: error,
          });
        }
        throw error;
      }
      const usage = { input: message.usage.input_tokens, output: message.usage.output_tokens };
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      let output: T | null = null;
      if (message.stop_reason === "end_turn" && text.length > 0) {
        try {
          const parsed = schema.safeParse(JSON.parse(text.join("")));
          output = parsed.success ? parsed.data : null;
        } catch {
          // Not JSON at all.
        }
      }
      return { output, stopReason: message.stop_reason, usage };
    },
  };
}

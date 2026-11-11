import type { Meter } from "@ponzu/evals";
import { createModel, type Model } from "../../src/deps/model.ts";

/**
 * The API's own `Model` (the adapter production uses, with its timeout, retries and structured
 * output) on a Claude model of the evals' key, every call refused past the cap and priced after.
 */
export function meteredModel(
  model: Parameters<typeof createModel>[0],
  meter: Meter,
  label: string,
): Model {
  const inner = createModel(model, { timeoutMs: 120_000 });
  return {
    id: inner.id,
    async structured(request) {
      const hold = meter.reserve(inner.id, {
        maxOutputTokens: request.maxTokens,
        inputChars: request.instructions.length + request.prompt.length,
      });
      try {
        const answer = await inner.structured(request);
        meter.record(inner.id, label, answer.usage, hold);
        return answer;
      } finally {
        meter.release(hold);
      }
    },
  };
}

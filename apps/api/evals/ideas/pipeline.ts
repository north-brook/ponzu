import type { Model } from "../../src/deps/model.ts";
import { askForIdeas, newTally } from "../../src/ideas/ideas.ts";
import { ideasRequest } from "../../src/ideas/prompt.ts";
import type { RepoSnapshot } from "../../src/ideas/snapshot.ts";

/** What one generation came to: what a person would be shown, and how it got there. */
export interface Generated {
  /** `kept`, `withheld` or `rejected`. */
  outcome: string;
  /** The ideas a person would see. */
  shown: string[];
  attempts: number;
  /** Anything else worth reading in the report: what the gate failed and why. */
  detail: unknown;
}

export const PIPELINE = "exact checks, then the gate (Claude Sonnet 5.5) on safe and design";

/** One generation, the way the API makes it (`askForIdeas`), with nothing stored. */
export async function generate(
  models: { writer: Model; gate: Model },
  snapshot: RepoSnapshot,
): Promise<Generated> {
  const tally = newTally();
  const asked = await askForIdeas(
    { writer: models.writer, reviewer: models.gate },
    ideasRequest(snapshot),
    { tally },
  );
  return {
    outcome: asked.kind,
    shown: asked.kind === "kept" ? asked.ideas : [],
    attempts: tally.attempts,
    detail: {
      gateCalls: tally.gate.calls,
      failures: asked.failures,
      ...(asked.kind === "rejected" ? { codes: asked.codes } : {}),
    },
  };
}

import { getDesign, getEventOrigins } from "@ponzu/db";
import type { TurnUsage } from "@ponzu/runner/protocol";
import { stableUuid } from "../analytics/analytics.ts";
import type { Deps } from "../deps/index.ts";
import { runnerImage } from "./client.ts";

/*
 * A design's turns in product analytics: "turn started" and "turn finished", from what the
 * runner reports as each turn ends (`POST /v1/runner/usage`). The runner's trace of the same
 * turn in LLM analytics carries the turn's id as its trace id, so the two meet.
 *
 * Who a turn is for is read from the row of the event that began it, never taken from the
 * sandbox: the person who sent the message, and the app session they sent it from.
 */

export async function reportTurns(
  deps: Pick<Deps, "db" | "analytics">,
  designId: string,
  turns: TurnUsage[],
  /** What the runner that reported them said it is (`X-Ponzu-Client`). */
  client: string | null = null,
): Promise<void> {
  const reported = turns.filter((turn) => turn.turn);
  if (reported.length === 0) return;
  const [design, origins] = await Promise.all([
    getDesign(deps.db, designId),
    getEventOrigins(deps.db, {
      designId,
      ids: reported.flatMap(({ turn }) => (turn?.eventId ? [turn.eventId] : [])),
    }),
  ]);
  if (!design) return;
  for (const { id, at, models, turn } of reported) {
    if (!turn) continue;
    const origin = turn.eventId ? origins.get(turn.eventId) : undefined;
    const options = {
      distinctId: origin?.userId ?? null,
      workspaceId: design.workspaceId,
      ...(origin?.posthogSessionId ? { sessionId: origin.posthogSessionId } : {}),
    };
    const sum = (pick: (model: TurnUsage["models"][number]) => number) =>
      models.reduce((total, model) => total + pick(model), 0);
    deps.analytics.capture(
      "turn started",
      { design_id: designId, turn_id: id },
      { ...options, timestamp: new Date(turn.startedAt), uuid: stableUuid(`${id}/started`) },
    );
    deps.analytics.capture(
      "turn finished",
      {
        design_id: designId,
        turn_id: id,
        outcome: turn.outcome,
        error_code: turn.errorCode,
        duration_ms: turn.durationMs,
        tool_calls: turn.toolCalls,
        models: models.map((model) => model.model),
        input_tokens: sum((model) => model.inputTokens),
        output_tokens: sum((model) => model.outputTokens),
        cache_read_tokens: sum((model) => model.cacheReadTokens),
        cache_write_tokens: sum((model) => model.cacheWriteTokens),
        cost_usd: sum((model) => model.costUsd),
        runner: client,
        image: runnerImage(client),
      },
      { ...options, timestamp: new Date(at), uuid: stableUuid(`${id}/finished`) },
    );
  }
}

import { OpenTelemetry } from "@ai-sdk/otel";
import { BasicTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TelemetryOptions } from "ai";
import { type OptOuts, WORKSPACE_GROUP } from "./analytics.ts";
import { currentScope } from "./scope.ts";

/*
 * Model calls the API makes itself, in PostHog's LLM analytics. This is the one way such a call
 * is traced: spread `tracing.call(feature, …)` into the AI SDK call (`deps/model.ts` does, for
 * every structured ask), and the call becomes a trace of spans and generations, attributed to
 * the person and workspace it was made for.
 *
 * It is PostHog's documented path for AI SDK v7 (`@ai-sdk/otel` with `PostHogSpanProcessor`):
 * `withTracing` from `@posthog/ai` wraps v5 and v6 models only, and refuses v7's. The tracer is
 * the API's own, passed to each call, rather than one registered for the whole process, so
 * nothing else in the process is traced and a test can read the spans.
 *
 * Content (the instructions, the prompt, the answer) is recorded only when
 * PONZU_POSTHOG_AI_CONTENT is "1": otherwise the AI SDK does not record it and the processor
 * drops whatever might carry it, and only the model, tokens, cost, latency and outcome go.
 */

export interface AiTracing {
  /** Whether prompts and answers are recorded. */
  readonly content: boolean;
  /**
   * What to spread into one AI SDK call (`generateText`, `streamText`) of `feature`, about
   * `workspaceId`: its telemetry, and the context PostHog reads its attribution from.
   */
  call(
    feature: string,
    about: { workspaceId: string | null },
  ): { telemetry: TelemetryOptions; runtimeContext: Record<string, unknown> };
  /** Sends the spans that have ended. */
  flush(): Promise<void>;
}

/**
 * Tracing whose spans end in `processor`: PostHog's span processor in a deployment, an in-memory
 * one under test.
 */
export function createAiTracing({
  processor,
  content,
}: {
  processor: SpanProcessor;
  content: boolean;
}): AiTracing {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const integration = new OpenTelemetry({
    tracer: provider.getTracer("ponzu-api"),
    // Every span of a call says which feature made it and which workspace it was for, as
    // properties PostHog keeps on the events it makes of them.
    enrichSpan: ({ runtimeContext }) => {
      const feature = runtimeContext?.feature;
      const workspaceId = runtimeContext?.workspaceId;
      return {
        ...(typeof feature === "string" ? { feature } : {}),
        ...(typeof workspaceId === "string"
          ? {
              workspace_id: workspaceId,
              $groups: JSON.stringify({ [WORKSPACE_GROUP]: workspaceId }),
            }
          : {}),
      };
    },
  });
  return {
    content,
    call(feature, about) {
      const workspaceId = about.workspaceId ?? currentScope()?.workspaceId ?? null;
      return {
        telemetry: {
          functionId: feature,
          recordInputs: content,
          recordOutputs: content,
          includeRuntimeContext: { feature: true, workspaceId: true },
          integrations: integration,
        },
        runtimeContext: { feature, ...(workspaceId ? { workspaceId } : {}) },
      };
    },
    flush: () => provider.forceFlush(),
  };
}

/**
 * Who a span is about, as `PostHogSpanProcessor` asks its `client`: the request's person and the
 * app session that sent it, read when each span starts.
 *
 * With `optOuts`, a person who has turned usage sharing off is left off: the span is still the
 * workspace's, about no one. Spans start on the request path, so this reads only the copy the
 * analytics' sends hold, and only while it is fresh: with no fresh copy it asks for one and
 * leaves everyone off, so an idle instance's old copy never attributes a span to anyone.
 */
export function scopeContextFor(optOuts: OptOuts | null = null) {
  return {
    getContext() {
      const scope = currentScope();
      if (!scope) return undefined;
      let distinctId = scope.userId();
      let sessionId = scope.sessionId;
      if (optOuts && distinctId) {
        const out = optOuts.fresh();
        if (!out) void optOuts.current().catch(() => {});
        if (!out || out.has(distinctId)) {
          distinctId = null;
          sessionId = null;
        }
      }
      return {
        ...(distinctId ? { distinctId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    },
  };
}

/** Who a span is about, with no one left off. */
export const scopeContext = scopeContextFor();

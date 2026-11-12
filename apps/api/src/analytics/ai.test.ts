import { expect, test } from "bun:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { CLAUDE_HAIKU, createClaude } from "../deps/model.ts";
import { createAiTracing, scopeContext } from "./ai.ts";
import { withScope } from "./scope.ts";

// A model call the API makes, traced as PostHog's AI SDK v7 path traces it, with the spans kept
// in memory instead of exported: what PostHog would turn into its trace and generation.

const Schema = z.object({ ideas: z.array(z.string()) });

function traced(content: boolean) {
  const exporter = new InMemorySpanExporter();
  const tracing = createAiTracing({ processor: new SimpleSpanProcessor(exporter), content });
  const model = createClaude({
    apiKey: "sk-ant-test",
    tracing,
    fetch: async () =>
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: CLAUDE_HAIKU,
        content: [{ type: "text", text: JSON.stringify({ ideas: ["A quieter hero"] }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_200, output_tokens: 90 },
      }),
  });
  return { exporter, model, tracing };
}

const ask = {
  instructions: "Write ideas about the product.",
  prompt: "THE SECRET PRODUCT DESCRIPTION",
  schema: Schema,
  maxTokens: 4_000,
  effort: "low" as const,
  feature: { name: "repo_ideas", workspaceId: "ws_1" },
};

const scope = {
  userId: () => "usr_ada",
  canvasId: () => null,
  sessionId: "0192e0a0-0000-7000-8000-000000000001",
  requestId: "req_1",
  route: () => "GET /v1/repos/:id/ideas",
  workspaceId: null,
};

test("a model call is one trace of its feature, for the workspace it was asked for", async () => {
  const { exporter, model, tracing } = traced(false);
  const answer = await model.structured(ask);
  expect(answer.output).toEqual({ ideas: ["A quieter hero"] });
  await tracing.flush();

  const spans = exporter.getFinishedSpans();
  expect(spans.length).toBeGreaterThan(0);
  // One trace, and every span of it says what asked and for whom.
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  for (const span of spans) {
    expect(span.attributes).toMatchObject({
      feature: "repo_ideas",
      workspace_id: "ws_1",
      $groups: JSON.stringify({ workspace: "ws_1" }),
    });
  }
  // The call itself, with its model and tokens.
  const chat = spans.find((span) => span.attributes["gen_ai.usage.input_tokens"] !== undefined);
  expect(chat?.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 1_200,
    "gen_ai.usage.output_tokens": 90,
  });
});

test("with content off, neither the instructions, the prompt nor the answer is recorded", async () => {
  const { exporter, model, tracing } = traced(false);
  await model.structured(ask);
  await tracing.flush();
  const recorded = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
  expect(recorded).not.toContain("THE SECRET PRODUCT DESCRIPTION");
  expect(recorded).not.toContain("Write ideas about the product.");
  expect(recorded).not.toContain("A quieter hero");
});

test("with content on, the prompt and the answer are recorded", async () => {
  const { exporter, model, tracing } = traced(true);
  await model.structured(ask);
  await tracing.flush();
  const recorded = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
  expect(recorded).toContain("THE SECRET PRODUCT DESCRIPTION");
  expect(recorded).toContain("A quieter hero");
});

test("PostHog's span processor reads who a call is for, and their app session, from the request", () => {
  expect(withScope(scope, () => scopeContext.getContext())).toEqual({
    distinctId: "usr_ada",
    sessionId: "0192e0a0-0000-7000-8000-000000000001",
  });
  // Work no request started (the cron's) is about nobody in particular.
  expect(scopeContext.getContext()).toBeUndefined();
});

test("a feature asked about no workspace takes the request's", () => {
  const { tracing } = traced(false);
  const call = withScope({ ...scope, workspaceId: "ws_from_request" }, () =>
    tracing.call("repo_ideas", { workspaceId: null }),
  );
  expect(call.runtimeContext).toEqual({ feature: "repo_ideas", workspaceId: "ws_from_request" });
});

test("without tracing a call is made exactly as before", async () => {
  const model = createClaude({
    apiKey: "sk-ant-test",
    fetch: async () =>
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: CLAUDE_HAIKU,
        content: [{ type: "text", text: JSON.stringify({ ideas: ["One"] }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  });
  expect((await model.structured(ask)).output).toEqual({ ideas: ["One"] });
});

import { expect, test } from "bun:test";
import { z } from "zod";
import { UpstreamError } from "../http/errors.ts";
import { CLAUDE_HAIKU, createClaude } from "./model.ts";

// The real adapter, over a `fetch` that answers as Anthropic's Messages API does: what the AI SDK
// sends, and what each kind of answer becomes. Nothing reaches the network.

const Schema = z.object({ ideas: z.array(z.string()) });

function claudeServing(serve: (body: Record<string, unknown>) => Response | "hang") {
  const sent: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  const model = createClaude({
    apiKey: "sk-ant-test",
    fetch: async (url, init = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ url, key: new Headers(init.headers).get("x-api-key"), body });
      const answer = serve(body);
      if (answer !== "hang") return answer;
      // No answer until the request is given up, as `fetch` does.
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  return { model, sent };
}

const message = (text: string, stop_reason = "end_turn") =>
  Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU,
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1_200, output_tokens: 90 },
  });

const ask = {
  instructions: "Write ideas.",
  prompt: "The product.",
  schema: Schema,
  maxTokens: 4_000,
};

test("it asks Claude Haiku on Anthropic's API, with the schema, the effort and the key", async () => {
  const { model, sent } = claudeServing(() => message(JSON.stringify({ ideas: ["One", "Two"] })));
  const answer = await model.structured({ ...ask, effort: "medium" });
  expect(answer).toEqual({
    output: { ideas: ["One", "Two"] },
    finishReason: "stop",
    usage: { input: 1_200, output: 90 },
  });
  expect(model.id).toBe(CLAUDE_HAIKU);
  expect(sent).toHaveLength(1);
  const [{ url, key, body }] = sent as [(typeof sent)[number]];
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(key).toBe("sk-ant-test");
  expect(body).toMatchObject({ model: CLAUDE_HAIKU, max_tokens: 4_000 });
  expect(JSON.stringify(body.system)).toContain("Write ideas.");
  expect(JSON.stringify(body.messages)).toContain("The product.");
  const config = JSON.stringify(body.output_config);
  expect(config).toContain('"effort":"medium"');
  expect(config).toContain('"ideas"');
});

test("an answer not in the shape asked for is no output, with what it cost", async () => {
  for (const text of ['{"ideas": "not a list"}', "Sure! Here are some ideas"]) {
    const { model } = claudeServing(() => message(text));
    const answer = await model.structured({ ...ask, effort: "low" });
    expect(answer.output).toBeNull();
    expect(answer.usage).toEqual({ input: 1_200, output: 90 });
  }
  const { model } = claudeServing(() => message('{"ideas": ["cut o', "max_tokens"));
  expect(await model.structured({ ...ask, effort: "low" })).toMatchObject({
    output: null,
    finishReason: "length",
  });
});

test("no answer at all is an UpstreamError from the model, after one retry at most", async () => {
  const failing = (status: number) =>
    Response.json({ type: "error", error: { type: "api_error", message: "no" } }, { status });

  const overloaded = claudeServing(() => failing(529));
  const error = await overloaded.model.structured({ ...ask, effort: "low" }).catch((e) => e);
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error).toMatchObject({ service: "model", status: 529 });
  expect(overloaded.sent).toHaveLength(2);

  const refused = claudeServing(() => failing(401));
  await expect(refused.model.structured({ ...ask, effort: "low" })).rejects.toMatchObject({
    service: "model",
    status: 401,
  });
  expect(refused.sent).toHaveLength(1);

  const hanging = claudeServing(() => "hang");
  const signal = AbortSignal.timeout(20);
  await expect(hanging.model.structured({ ...ask, effort: "low", signal })).rejects.toBeInstanceOf(
    UpstreamError,
  );
});

import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type { AiEvent } from "./agent/trace.ts";
import { posthogTelemetry } from "./telemetry.ts";

/** A PostHog that keeps each batch it is sent, as JSON, and answers as PostHog does. */
function sink(answer: () => Response | Promise<Response> = () => new Response("{}")) {
  const batches: { url: string; body: { api_key: string; batch: Record<string, any>[] } }[] = [];
  const fetch = async (url: string, options: { body?: unknown }) => {
    const raw = options.body;
    const text =
      typeof raw === "string"
        ? raw
        : gunzipSync(
            new Uint8Array(raw instanceof Blob ? await raw.arrayBuffer() : (raw as Uint8Array)),
          ).toString();
    batches.push({ url, body: JSON.parse(text) });
    const response = await answer();
    return {
      status: response.status,
      text: () => response.text(),
      json: () => response.json(),
      headers: response.headers,
    } as never;
  };
  return { batches, fetch };
}

const trace = (person: string | null): AiEvent[] => [
  {
    event: "$ai_generation",
    distinctId: person,
    properties: { $ai_trace_id: "res-1", $ai_model: "claude-haiku-5-5", canvas_id: "cnv_1" },
    groups: { workspace: "ws_1" },
  },
  { event: "$ai_trace", distinctId: person, properties: { $ai_trace_id: "res-1" } },
];

test("a turn's events reach PostHog as one batch on flush, under the project's token", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch },
  );
  telemetry.capture(trace("usr_ada"));
  // Nothing has been sent: a capture only queues.
  expect(ph.batches).toEqual([]);
  await telemetry.flush();

  expect(ph.batches).toHaveLength(1);
  const [{ url, body }] = ph.batches as [(typeof ph.batches)[number]];
  expect(url.startsWith("https://ph.test/")).toBe(true);
  expect(body.api_key).toBe("phc_test");
  expect(body.batch.map((e) => [e.event, e.distinct_id])).toEqual([
    ["$ai_generation", "usr_ada"],
    ["$ai_trace", "usr_ada"],
  ]);
  expect(body.batch[0]!.properties).toMatchObject({
    $ai_trace_id: "res-1",
    canvas_id: "cnv_1",
    $groups: { workspace: "ws_1" },
  });
  await telemetry.shutdown();
});

test("every event says which runner, and so which image, its turn ran on", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch, client: "runner/0.1.0+2de5aff8d903" },
  );
  telemetry.capture(trace("usr_ada"));
  await telemetry.flush();
  expect(ph.batches[0]!.body.batch.map((e) => e.properties.ponzu_runner)).toEqual([
    "runner/0.1.0+2de5aff8d903",
    "runner/0.1.0+2de5aff8d903",
  ]);
  await telemetry.shutdown();
});

test("a trace about no one is keyed by its own id", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch },
  );
  telemetry.capture(trace(null));
  await telemetry.flush();
  expect(ph.batches[0]!.body.batch.map((e) => e.distinct_id)).toEqual(["res-1", "res-1"]);
  await telemetry.shutdown();
});

test("PostHog down never throws into the capture", async () => {
  const ph = sink(() => new Response("nope", { status: 503 }));
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch },
  );
  expect(() => telemetry.capture(trace("usr_ada"))).not.toThrow();
  await telemetry.flush().catch(() => {});
  await telemetry.shutdown().catch(() => {});
  expect(ph.batches.length).toBeGreaterThan(0);
});

test("with content on, no secret the agent's environment holds leaves in what it saw or said", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: true },
    { fetch: ph.fetch, secrets: ["stripe-live-0123456789", "1"] },
  );
  // The agent ran `env`, and read a file holding the Claude credential.
  const printed = "STRIPE_KEY=stripe-live-0123456789\nPATH=/usr/bin\nONE=1";
  telemetry.capture([
    {
      event: "$ai_span",
      distinctId: "usr_ada",
      properties: {
        $ai_trace_id: "res-1",
        $ai_span_name: "Bash",
        $ai_input_state: { command: "env" },
        $ai_output_state: [{ type: "text", text: printed }],
      },
    },
    {
      event: "$ai_generation",
      distinctId: "usr_ada",
      properties: {
        $ai_trace_id: "res-1",
        $ai_input_tokens: 1200,
        $ai_input: [
          {
            role: "user",
            content: [
              { type: "tool_result", content: "it is sk-ant-oat01-abcdefghijklmnopqrstuvwxyz" },
            ],
          },
        ],
        $ai_output_choices: [{ role: "assistant", content: [{ type: "text", text: printed }] }],
      },
    },
  ]);
  await telemetry.flush();
  const [span, generation] = ph.batches[0]!.body.batch as [
    Record<string, any>,
    Record<string, any>,
  ];
  const sent = JSON.stringify(ph.batches);
  expect(sent).not.toContain("stripe-live-0123456789");
  expect(sent).not.toContain("sk-ant-oat01");
  expect(span.properties.$ai_output_state).toEqual([
    { type: "text", text: "STRIPE_KEY=[redacted]\nPATH=/usr/bin\nONE=1" },
  ]);
  expect(span.properties.$ai_input_state).toEqual({ command: "env" });
  // What only looks like a secret's name is a count, and stays.
  expect(generation.properties.$ai_input_tokens).toBe(1200);
  expect(generation.properties.$ai_input[0].content[0].content).toBe("it is [redacted]");
  await telemetry.shutdown();
});

/* ------------------------------------------------------------------ */
/* The agent's feedback                                                */
/* ------------------------------------------------------------------ */

const FEEDBACK = {
  canvasId: "cnv_1",
  workspaceId: "ws_1",
  sentiment: "negative",
  category: "confusing_tool",
  summary: "write_html dropped a style without saying why.",
  details: "It said nothing about the grid-template rule it left out.",
  tool: "write_html",
  client: "claude",
} as const;

test("feedback with content off sends its kinds and tool, never its words, about no one", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch, client: "runner/0.1.0+2de5aff8d903" },
  );
  telemetry.feedback(FEEDBACK);
  expect(ph.batches).toEqual([]);
  await telemetry.flush();

  const [event] = ph.batches[0]!.body.batch as [Record<string, any>];
  expect(event.event).toBe("agent feedback sent");
  expect(event.distinct_id).toBe("ws_1");
  expect(event.properties).toMatchObject({
    canvas_id: "cnv_1",
    workspace_id: "ws_1",
    sentiment: "negative",
    category: "confusing_tool",
    tool: "write_html",
    summary: null,
    details: null,
    $process_person_profile: false,
    ponzu_runner: "runner/0.1.0+2de5aff8d903",
    $groups: { workspace: "ws_1" },
  });
  // Which agent sent it is not one of its properties; its words are nowhere in what was sent.
  expect(event.properties.client).toBeUndefined();
  const sent = JSON.stringify(ph.batches);
  expect(sent).not.toContain("dropped a style");
  expect(sent).not.toContain("grid-template");
  await telemetry.shutdown();
});

test("feedback with content on carries its words, scrubbed of every secret the runner knows", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: true },
    { fetch: ph.fetch, secrets: ["stripe-live-0123456789", "pzr_0123456789abcdefghij"] },
  );
  telemetry.feedback({
    ...FEEDBACK,
    summary: "The build failed with STRIPE_KEY=stripe-live-0123456789 in its output.",
    details:
      "curl said 401 for Bearer pzr_0123456789abcdefghij, and printed sk-ant-oat01-abcdefghijklmnopqrstuvwxyz.",
  });
  await telemetry.flush();

  const [event] = ph.batches[0]!.body.batch as [Record<string, any>];
  expect(event.properties.summary).toBe(
    "The build failed with STRIPE_KEY=[redacted] in its output.",
  );
  expect(event.properties.details).toBe("curl said 401 for [redacted], and printed [redacted].");
  const sent = JSON.stringify(ph.batches);
  expect(sent).not.toContain("stripe-live-0123456789");
  expect(sent).not.toContain("pzr_0123456789abcdefghij");
  expect(sent).not.toContain("sk-ant-oat01");
  await telemetry.shutdown();
});

test("feedback names a tool only by a tool's name, and goes under the canvas without a workspace", async () => {
  const ph = sink();
  const telemetry = posthogTelemetry(
    { key: "phc_test", host: "https://ph.test", content: false },
    { fetch: ph.fetch },
  );
  telemetry.feedback({ ...FEEDBACK, workspaceId: null, tool: "the one at /Users/ada/notes.txt" });
  telemetry.feedback({ ...FEEDBACK, workspaceId: null, tool: undefined, details: undefined });
  await telemetry.flush();

  const events = ph.batches[0]!.body.batch as Record<string, any>[];
  expect(events.map((e) => [e.distinct_id, e.properties.tool])).toEqual([
    ["cnv_1", null],
    ["cnv_1", null],
  ]);
  expect(events[0]!.properties.workspace_id).toBeUndefined();
  expect(events[0]!.properties.$groups).toBeUndefined();
  expect(JSON.stringify(ph.batches)).not.toContain("/Users/ada");
  await telemetry.shutdown();
});

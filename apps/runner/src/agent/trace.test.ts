import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AiEvent, type TraceOptions, TurnTrace } from "./trace.ts";

// Shapes as Claude Code sends them through the Agent SDK, trimmed to what is read.
const SESSION = { session_id: "sess_1", uuid: "00000000-0000-4000-8000-000000000000" };

function msg(m: Record<string, unknown>): SDKMessage {
  return { ...SESSION, parent_tool_use_id: null, ...m } as unknown as SDKMessage;
}

const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  msg({ type: "stream_event", event, ...extra });

const result = (over: Record<string, unknown> = {}) =>
  msg({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    duration_ms: 4_000,
    uuid: "res-turn-1",
    ...over,
  });

const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  msg({
    type: "assistant",
    message: {
      id,
      model: "claude-haiku-5-5",
      content,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    ...extra,
  });

const toolResult = (id: string, isError = false, parent: string | null = null) =>
  msg({
    type: "user",
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }],
    },
  });

function traced(over: Partial<TraceOptions> = {}) {
  const sent: AiEvent[][] = [];
  let clock = 1_000;
  const trace = new TurnTrace(
    {
      sink: (events) => sent.push(events),
      content: false,
      designId: "des_1",
      workspaceId: "ws_1",
      ...over,
    },
    () => clock,
  );
  return {
    trace,
    sent,
    tick: (ms: number) => {
      clock += ms;
    },
    feed: (...messages: SDKMessage[]) => messages.map((m) => trace.observe(m)),
  };
}

/** The main agent's turn: a model call that asks for a tool, the tool, and the answer. */
function aTurn(t: ReturnType<typeof traced>) {
  t.trace.put(
    "u1",
    "Make it blue",
    { eventId: "evt_1", userId: "usr_ada", sessionId: "s-1" },
    false,
  );
  t.feed(
    stream(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-haiku-5-5",
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_read_input_tokens: 9_000,
            cache_creation_input_tokens: 300,
          },
        },
      },
      { user_message_uuids: ["u1"] },
    ),
  );
  t.tick(200);
  t.feed(
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it" } }),
  );
  t.tick(800);
  t.feed(
    assistant("msg_1", [
      { type: "text", text: "On it." },
      { type: "tool_use", id: "toolu_1", name: "mcp__ponzu__write_html", input: { html: "<p>" } },
    ]),
    stream({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 40 },
    }),
    stream({ type: "message_stop" }),
  );
  t.tick(500);
  t.feed(toolResult("toolu_1", true));
}

test("a turn is one trace: its model call and tool call, under the turn's id, for who began it", () => {
  const t = traced();
  aTurn(t);
  const [summary] = t.feed(result()).filter(Boolean);

  expect(summary).toEqual({
    startedAt: new Date(1_000).toISOString(),
    toolCalls: 1,
    eventId: "evt_1",
  });
  expect(t.sent).toHaveLength(1);
  const events = t.sent[0]!;
  expect(events.map((e) => e.event)).toEqual(["$ai_generation", "$ai_span", "$ai_trace"]);
  for (const event of events) {
    expect(event.distinctId).toBe("usr_ada");
    expect(event.groups).toEqual({ workspace: "ws_1" });
    expect(event.properties).toMatchObject({
      $ai_trace_id: "res-turn-1",
      $ai_session_id: "des_1",
      $session_id: "s-1",
      design_id: "des_1",
    });
  }
  const [generation, span, trace] = events.map((e) => e.properties);
  expect(generation).toMatchObject({
    $ai_span_id: "msg_1",
    $ai_parent_id: "res-turn-1",
    $ai_model: "claude-haiku-5-5",
    $ai_provider: "anthropic",
    $ai_input_tokens: 12,
    $ai_output_tokens: 40,
    $ai_cache_read_input_tokens: 9_000,
    $ai_cache_creation_input_tokens: 300,
    $ai_latency: 1,
    $ai_time_to_first_token: 0.2,
    $ai_stop_reason: "tool_use",
  });
  expect(span).toMatchObject({
    $ai_span_id: "toolu_1",
    $ai_parent_id: "msg_1",
    $ai_span_name: "mcp__ponzu__write_html",
    $ai_latency: 0.5,
    $ai_is_error: true,
  });
  expect(trace).toMatchObject({ $ai_latency: 4, $ai_is_error: false, tool_calls: 1 });
});

test("with content off, no prompt, reply, argument or result goes", () => {
  const t = traced();
  aTurn(t);
  t.feed(result());
  const text = JSON.stringify(t.sent);
  for (const secret of ["Make it blue", "On it.", "<p>", '"ok"'])
    expect(text).not.toContain(secret);
  const [generation, span, trace] = t.sent[0]!.map((e) => e.properties);
  expect(generation).toMatchObject({ $ai_input: null, $ai_output_choices: null });
  expect(span).toMatchObject({ $ai_input_state: null, $ai_output_state: null });
  expect(trace).toMatchObject({ $ai_input_state: null, $ai_output_state: null });
});

test("with content on, the prompt, the reply and the tool's arguments and result go with it", () => {
  const t = traced({ content: true });
  aTurn(t);
  t.feed(result());
  const [generation, span, trace] = t.sent[0]!.map((e) => e.properties);
  expect(generation!.$ai_input).toEqual([{ role: "user", content: "Make it blue" }]);
  expect(generation!.$ai_output_choices).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        {
          type: "function",
          function: { name: "mcp__ponzu__write_html", arguments: { html: "<p>" } },
        },
      ],
    },
  ]);
  expect(span).toMatchObject({ $ai_input_state: { html: "<p>" }, $ai_output_state: "ok" });
  expect(trace).toMatchObject({ $ai_output_state: "On it." });
});

test("a subagent's model calls and tools hang under the tool call that started it, each once", () => {
  const t = traced();
  t.trace.put("u1", "Research it", null, false);
  t.feed(
    assistant("msg_1", [{ type: "tool_use", id: "toolu_task", name: "Task", input: {} }], {
      user_message_uuids: ["u1"],
    }),
    // The subagent's call arrives in two messages, its usage growing: one generation.
    assistant("msg_sub", [{ type: "text", text: "Looking" }], {
      parent_tool_use_id: "toolu_task",
      message: {
        id: "msg_sub",
        model: "claude-haiku-5-5",
        content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: {} }],
        stop_reason: null,
        usage: { input_tokens: 50, output_tokens: 5 },
      },
    }),
    assistant("msg_sub", [], {
      parent_tool_use_id: "toolu_task",
      message: {
        id: "msg_sub",
        model: "claude-haiku-5-5",
        content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 30 },
      },
    }),
    toolResult("toolu_grep", false, "toolu_task"),
    toolResult("toolu_task"),
  );
  const [summary] = t.feed(result()).filter(Boolean);

  expect(summary!.toolCalls).toBe(2);
  const events = t.sent[0]!;
  const generations = events.filter((e) => e.event === "$ai_generation").map((e) => e.properties);
  expect(generations).toHaveLength(2);
  expect(generations[1]).toMatchObject({
    $ai_span_id: "msg_sub",
    $ai_parent_id: "toolu_task",
    $ai_span_name: "subagent",
    $ai_input_tokens: 50,
    $ai_output_tokens: 30,
  });
  const spans = events.filter((e) => e.event === "$ai_span").map((e) => e.properties);
  expect(spans.map((s) => [s.$ai_span_id, s.$ai_parent_id])).toEqual([
    ["toolu_task", "msg_1"],
    ["toolu_grep", "msg_sub"],
  ]);
  // A message from no one: the trace is nobody's.
  expect(events[0]!.distinctId).toBeNull();
  expect(events[0]!.properties.$process_person_profile).toBe(false);
});

test("a message put in aside ends with no turn, and a failed turn says how by kind, never by words", () => {
  const t = traced();
  t.trace.put("u_aside", "An edit", null, true);
  expect(
    t.feed(
      msg({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "r0",
        duration_ms: 1,
        user_message_uuids: ["u_aside"],
      }),
    ),
  ).toEqual([null]);
  expect(t.sent).toEqual([]);

  t.feed(assistant("msg_1", [{ type: "text", text: "Hm" }]));
  t.feed(result({ is_error: true, result: "Your secret plan failed", api_error_status: 429 }));
  const trace = t.sent[0]!.at(-1)!.properties;
  expect(trace).toMatchObject({ $ai_is_error: true, $ai_error: "api_error_429" });
  expect(JSON.stringify(t.sent)).not.toContain("secret plan");
});

test("a turn the run never finished goes out as unfinished, and without analytics nothing goes", () => {
  const t = traced();
  t.feed(assistant("msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }]));
  t.trace.abandon();
  const events = t.sent[0]!;
  expect(events.at(-1)!.properties).toMatchObject({ $ai_is_error: true, $ai_error: "unfinished" });
  expect(events.find((e) => e.event === "$ai_span")!.properties.unfinished).toBe(true);

  const off = new TurnTrace(null);
  off.observe(assistant("msg_1", [{ type: "text", text: "Hi" }]));
  expect(off.observe(result())).toMatchObject({ toolCalls: 0, eventId: null });
});

test("a sink that throws never reaches the run", () => {
  const trace = new TurnTrace({
    sink: () => {
      throw new Error("PostHog is down");
    },
    content: false,
    designId: "des_1",
    workspaceId: null,
  });
  trace.observe(assistant("msg_1", [{ type: "text", text: "Hi" }]));
  expect(() => trace.observe(result())).not.toThrow();
});

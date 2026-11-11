import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { callResult, repoServers, sessionHistory, Translator, turnError } from "./sdk.ts";

// Shapes as Claude Code 2.1.322 sent them through the Agent SDK 0.3.322, trimmed to what is read.
const SESSION = { session_id: "sess_1", uuid: "00000000-0000-4000-8000-000000000000" };

function msg(m: Record<string, unknown>): SDKMessage {
  return { ...SESSION, parent_tool_use_id: null, ...m } as unknown as SDKMessage;
}

function result(over: Record<string, unknown>): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...SESSION,
    ...over,
  } as unknown as SDKResultMessage;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("init says the session is up, and which MCP servers did not connect", () => {
  const t = new Translator();
  const events = t.events(
    msg({
      type: "system",
      subtype: "init",
      model: "claude-haiku-5-5",
      mcp_servers: [
        { name: "ponzu", status: "connected" },
        { name: "linear", status: "failed" },
      ],
    }),
  );
  expect(events).toEqual([
    {
      type: "ready",
      sessionId: "sess_1",
      model: "claude-haiku-5-5",
      problems: ["The linear MCP server is failed."],
    },
  ]);
});

test("a message's lifecycle says when the session took it and when Claude Code is done with it", () => {
  const t = new Translator();
  const life = (state: string) =>
    t.events(msg({ type: "command_lifecycle", command_uuid: "u1", state }));
  expect(life("queued")).toEqual([]);
  expect(life("started")).toEqual([{ type: "taken", uuids: ["u1"] }]);
  expect(life("completed")).toEqual([{ type: "dropped", uuids: ["u1"] }]);
});

test("streamed text accumulates per reply and ends at the reply's stop", () => {
  const t = new Translator();
  const stream = (event: Record<string, unknown>, extra = {}) =>
    t.events(msg({ type: "stream_event", event, ...extra }));
  expect(
    stream({ type: "message_start", message: { id: "msg_1" } }, { user_message_uuids: ["u1"] }),
  ).toEqual([{ type: "taken", uuids: ["u1"] }]);
  expect(
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
  ).toEqual([{ type: "text", id: "msg_1", text: "Hel", done: false }]);
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
  expect(stream({ type: "message_stop" })).toEqual([
    { type: "text", id: "msg_1", text: "Hello", done: true },
  ]);
});

test("tool calls and their results are the main thread's only", () => {
  const t = new Translator();
  const call = msg({
    type: "assistant",
    message: {
      id: "msg_2",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
    },
  });
  expect(t.events(call)).toEqual([
    { type: "tool", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  ]);
  const done = msg({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a", is_error: false }],
    },
  });
  expect(t.events(done)).toEqual([{ type: "tool-done", id: "toolu_1", error: false }]);
  // A subagent's steps are part of the step that started it.
  expect(t.events({ ...call, parent_tool_use_id: "toolu_task" } as SDKMessage)).toEqual([]);
});

test("an API error's assistant message is not the agent speaking", () => {
  const t = new Translator();
  const failed = msg({
    type: "assistant",
    error: "authentication_failed",
    message: { id: "msg_x", content: [{ type: "text", text: "Invalid API key" }] },
  });
  expect(t.events(failed)).toEqual([]);
});

test("a result carries the running usage by model", () => {
  const t = new Translator();
  const [event] = t.events(
    result({
      modelUsage: {
        "claude-haiku-5-5": {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 20,
          costUSD: 0.002,
          webSearchRequests: 0,
          contextWindow: 200_000,
          maxOutputTokens: 8_000,
        },
      },
    }),
  );
  expect(event).toEqual({
    type: "result",
    id: SESSION.uuid,
    ok: true,
    error: null,
    usage: [
      {
        model: "claude-haiku-5-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        costUsd: 0.002,
      },
    ],
  });
});

test("the result Claude Code writes for a message sent aside is no turn", () => {
  const t = new Translator();
  t.aside("u_edit");
  // As 2.1.322 sent it for `shouldQuery: false`: a result at once, costing nothing.
  const aside = result({ result: "", total_cost_usd: 0, user_message_uuids: ["u_edit"] });
  expect(t.events(aside)).toEqual([{ type: "taken", uuids: ["u_edit"] }]);
  // A real turn's result still ends the turn.
  const turn = t.events(result({ user_message_uuids: ["u_msg"] }));
  expect(turn.map((e) => e.type)).toEqual(["taken", "result"]);
});

test("a transcript holds its messages and the tool calls that went through, not those denied", () => {
  const result = (id: string, is_error: boolean) => ({
    type: "user",
    uuid: `u_${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error }] },
  });
  const history = sessionHistory([
    { type: "user", uuid: "u_msg", message: { role: "user", content: "Hello" } },
    { type: "assistant", uuid: "a_1", message: { content: [] } },
    result("toolu_answered", false),
    // A withdrawn question: canUseTool's deny, as the transcript keeps it.
    result("toolu_withdrawn", true),
  ]);
  expect([...history.messages]).toEqual(["u_msg", "u_toolu_answered", "u_toolu_withdrawn"]);
  expect([...history.toolResults]).toEqual(["toolu_answered"]);
});

test("is_error decides a turn failed, even when the subtype says success", () => {
  expect(turnError(result({}))).toBeNull();
  expect(
    turnError(result({ is_error: true, api_error_status: 401, result: "Invalid API key" })),
  ).toMatchObject({ code: "claude_auth" });
  expect(turnError(result({ is_error: true, api_error_status: 429, result: "Limit" }))).toEqual({
    code: "claude_limit",
    message: "Limit",
  });
  expect(
    turnError(result({ is_error: true, api_error_status: 404, result: "No model" })),
  ).toMatchObject({ code: "model_unavailable" });
  expect(
    turnError(
      result({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      }),
    ),
  ).toMatchObject({ code: "interrupted" });
  expect(
    turnError(result({ subtype: "error_max_turns", is_error: true, errors: ["Reached maximum"] })),
  ).toEqual({ code: "max_turns", message: "Reached maximum" });
  expect(
    turnError(result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })),
  ).toEqual({ code: "turn_failed", message: "boom" });
});

test("a tool's result goes to MCP as text, then its images", () => {
  expect(callResult({ text: "Shot.", images: [{ data: "AAAA", mime: "image/png" }] })).toEqual({
    content: [
      { type: "text", text: "Shot." },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  });
  expect(callResult({ text: "No.", isError: true })).toEqual({
    content: [{ type: "text", text: "No." }],
    isError: true,
  });
});

test("the repo's MCP servers come from its .mcp.json, and can't take Ponzu's name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-mcp-"));
  dirs.push(dir);
  expect(repoServers(dir)).toEqual({});
  await writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { type: "http", url: "https://docs.example/mcp" },
        ponzu: { type: "stdio", command: "evil" },
      },
    }),
  );
  expect(repoServers(dir)).toEqual({ docs: { type: "http", url: "https://docs.example/mcp" } });
  await writeFile(join(dir, ".mcp.json"), "{ not json");
  expect(repoServers(dir)).toEqual({});
});

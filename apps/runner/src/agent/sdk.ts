import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  type McpServerConfig,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ToolResult } from "@ponzu/tools";
import type { AskedQuestion, ModelUsage } from "../api/protocol.ts";
import type {
  Agent,
  AgentEvent,
  AgentInput,
  AgentOptions,
  AgentRun,
  AgentTool,
  Ask,
  Reply,
  SessionHistory,
  TurnError,
} from "./agent.ts";
import { Channel } from "./channel.ts";
import { PartialInput } from "./partial.ts";
import { type TurnSummary, TurnTrace } from "./trace.ts";

/** The MCP server the canvas tools are served as: the agent calls them `mcp__ponzu__<name>`. */
export const SERVER = "ponzu";

/** How often, at most, the run says Claude Code is alive. */
const ALIVE_EVERY_MS = 1_000;

export interface ClaudeAgentOptions {
  /** The `claude` binary to run. Without one the SDK runs the copy it installed. */
  executable?: string;
  /** Sent in Claude Code's User-Agent, like `ponzu-runner/0.1.0`. */
  client: string;
  /** Claude Code's own stderr, a line at a time. */
  log?: (line: string) => void;
  /** The environment Claude Code and its tools run in. The runner's own when absent. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The agent on the Agent SDK: one `query()` per session, fed through an input queue so the
 * Claude Code process stays up between turns, in a sandbox nobody can click "allow" in.
 *
 * - `bypassPermissions`: every tool runs without asking. AskUserQuestion, plan approval and
 *   anything else that needs a person still reach `canUseTool`, which turns them into `ask`
 *   events instead of answering them.
 * - The repo's project settings load (`settingSources: ["project"]`): its CLAUDE.md, skills,
 *   hooks and permission rules. The machine's user settings do not, and neither do the MCP
 *   servers in `~/.claude.json` (`strictMcpConfig`): the repo's `.mcp.json` servers are read
 *   here and passed beside Ponzu's, so they run without a prompt nobody could answer.
 * - The canvas tools are an in-process MCP server, always loaded rather than behind tool
 *   search: every turn uses them.
 */
export class ClaudeAgent implements Agent {
  constructor(private readonly opts: ClaudeAgentOptions) {}

  start(options: AgentOptions): AgentRun {
    return new ClaudeRun(this.opts, options);
  }

  async history(sessionId: string): Promise<SessionHistory | null> {
    if (!(await getSessionInfo(sessionId))) return null;
    return sessionHistory(await getSessionMessages(sessionId));
  }
}

/**
 * What a transcript holds. A tool result that is an error is left out: a question denied or
 * withdrawn (the turn stopped, the sandbox slept) was never answered, so a late answer to it
 * must still go in.
 */
export function sessionHistory(
  transcript: { type: string; uuid: string; message: unknown }[],
): SessionHistory {
  const messages = new Set<string>();
  const toolResults = new Set<string>();
  for (const m of transcript) {
    if (m.type !== "user") continue;
    messages.add(m.uuid);
    const content = (m.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_result" && !block.is_error && typeof block.tool_use_id === "string")
        toolResults.add(block.tool_use_id);
    }
  }
  return { messages, toolResults };
}

interface Pending {
  name: string;
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
}

class ClaudeRun implements AgentRun {
  private readonly inbox = new Channel<SDKUserMessage>();
  private readonly out = new Channel<AgentEvent>();
  private readonly pending = new Map<string, Pending>();
  private readonly translate = new Translator();
  /** Each turn as a trace in LLM analytics, and what the runner reports of it. */
  private readonly trace: TurnTrace;
  private readonly q: ReturnType<typeof query>;
  private readonly done: Promise<void>;

  constructor(agent: ClaudeAgentOptions, opts: AgentOptions) {
    this.trace = new TurnTrace(opts.trace ?? null);
    const server = createSdkMcpServer({
      name: SERVER,
      tools: opts.tools.map(sdkTool),
      alwaysLoad: true,
    });
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume ?? undefined,
        model: opts.model ?? undefined,
        effort: opts.effort ?? undefined,
        pathToClaudeCodeExecutable: agent.executable,
        systemPrompt: { type: "preset", preset: "claude_code", append: opts.instructions },
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["project"],
        strictMcpConfig: true,
        mcpServers: { ...repoServers(opts.cwd), [SERVER]: server },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: this.ask,
        includePartialMessages: true,
        env: {
          ...(agent.env ?? process.env),
          CLAUDE_AGENT_SDK_CLIENT_APP: agent.client,
          // A sandbox's Claude Code is the image's: it never updates itself.
          DISABLE_AUTOUPDATER: "1",
        },
        stderr: (data) => {
          for (const line of data.split("\n")) if (line.trim()) agent.log?.(line);
        },
      },
    });
    this.done = this.pump();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.out[Symbol.asyncIterator]();
  }

  send(input: AgentInput): void {
    const message: SDKUserMessage = {
      type: "user",
      uuid: input.uuid as SDKUserMessage["uuid"],
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
    };
    if (input.priority === "aside") {
      // Into the transcript, to be read with the next message that starts a turn.
      this.translate.aside(input.uuid);
      message.shouldQuery = false;
    } else {
      message.priority = input.priority;
    }
    // Text the runner wrote is delivered as written: no `@path` expansion, no slash commands.
    if (input.human) message.origin = { kind: "human" };
    else message.client_composed = true;
    this.trace.put(input.uuid, input.text, input.origin ?? null, input.priority === "aside");
    this.inbox.push(message);
  }

  reply(askId: string, reply: Reply): void {
    const pending = this.take(askId);
    if (!pending) return;
    if (pending.name === "AskUserQuestion") {
      pending.resolve({
        behavior: "allow",
        updatedInput: { ...pending.input, answers: reply.answers ?? {} },
      });
    } else if (reply.approved) {
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
    } else {
      const said = reply.note ? ` They said: ${reply.note}` : "";
      pending.resolve({ behavior: "deny", message: `The person said no.${said}` });
    }
  }

  withdraw(askId: string, reason: string): void {
    this.take(askId)?.resolve({ behavior: "deny", message: reason });
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.withdraw(id, "The session is closing.");
    this.inbox.close();
    this.q.close();
    await this.done;
  }

  private take(askId: string): Pending | undefined {
    const pending = this.pending.get(askId);
    this.pending.delete(askId);
    return pending;
  }

  /** The trace's reading of a message, which can never stop the run reading the next. */
  private observe(message: SDKMessage): TurnSummary | null {
    try {
      return this.trace.observe(message);
    } catch {
      return null;
    }
  }

  /** In `bypassPermissions` this is called only for what needs a person. */
  private ask: CanUseTool = (name, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const id = options.toolUseID;
      this.pending.set(id, { name, input, resolve });
      options.signal.addEventListener("abort", () => this.withdraw(id, "The turn was stopped."));
      this.out.push({ type: "ask", id, ask: askOf(name, input, options) });
    });

  private async pump(): Promise<void> {
    let error: string | null = null;
    let alive = 0;
    try {
      for await (const message of this.q) {
        // Anything at all, a subagent's included, which the translator leaves out.
        if (Date.now() - alive >= ALIVE_EVERY_MS) {
          alive = Date.now();
          this.out.push({ type: "alive" });
        }
        const turn = this.observe(message);
        for (const event of this.translate.events(message)) {
          this.out.push(event.type === "result" ? { ...event, turn } : event);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.trace.abandon();
    this.out.push({ type: "exit", error });
    this.out.close();
  }
}

/** What a `canUseTool` call asks of a person. */
function askOf(
  name: string,
  input: Record<string, unknown>,
  options: { title?: string; description?: string },
): Ask {
  if (name === "AskUserQuestion")
    return { kind: "question", questions: (input.questions as AskedQuestion[]) ?? [] };
  if (name === "ExitPlanMode") return { kind: "plan", plan: String(input.plan ?? "") };
  return {
    kind: "permission",
    tool: name,
    title: options.title ?? `Claude wants to use ${name}.`,
    description: options.description ?? null,
  };
}

/** A canvas tool in the SDK's form. The SDK takes zod shapes, as the tools are written. */
function sdkTool(def: AgentTool) {
  return tool(
    def.name,
    def.description,
    def.input,
    async (args) => callResult(await def.run(args)),
    {
      annotations: { readOnlyHint: !!def.readOnly, destructiveHint: !!def.destructive },
    },
  );
}

/** A tool's result as MCP carries it: its text, then its images. */
export function callResult(result: ToolResult) {
  return {
    content: [
      { type: "text" as const, text: result.text },
      ...(result.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mime,
      })),
    ],
    ...(result.isError ? { isError: true } : {}),
  };
}

/** The repo's own MCP servers, from `.mcp.json` at its root. Ponzu's name is Ponzu's. */
export function repoServers(cwd: string): Record<string, McpServerConfig> {
  const path = join(cwd, ".mcp.json");
  if (!existsSync(path)) return {};
  try {
    const servers = JSON.parse(readFileSync(path, "utf8"))?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const { [SERVER]: _ours, ...theirs } = servers as Record<string, McpServerConfig>;
    return theirs;
  } catch {
    return {};
  }
}

/**
 * The SDK's messages as the runner's events. Only the main thread's: a subagent's text and
 * tool calls are part of the one step that started it.
 */
export class Translator {
  /** Streamed text by API message id, until the reply ends. */
  private texts = new Map<string, string>();
  private current: string | null = null;
  /** Tool calls being written in the current message, by content block. */
  private calls = new Map<number, { id: string; input: PartialInput }>();
  /** Messages sent `aside`: Claude Code ends each with a result of its own, which is no turn. */
  private asides = new Set<string>();

  /** `uuid` goes in without starting a turn (`shouldQuery: false`). */
  aside(uuid: string): void {
    this.asides.add(uuid);
  }

  events(m: SDKMessage): AgentEvent[] {
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return [];
    const out: AgentEvent[] = [];
    const uuids = (m as { user_message_uuids?: string[] }).user_message_uuids;
    if (uuids?.length) out.push({ type: "taken", uuids });
    if (m.type === "result" && uuids?.length && uuids.every((u) => this.asides.has(u))) {
      for (const u of uuids) this.asides.delete(u);
      return out;
    }
    // Not in the SDK's types, but on its stream: each message's progress through the queue.
    const lifecycle = m as unknown as { type: string; command_uuid?: string; state?: string };
    if (lifecycle.type === "command_lifecycle" && lifecycle.command_uuid) {
      const uuids = [lifecycle.command_uuid];
      if (lifecycle.state === "started") out.push({ type: "taken", uuids });
      else if (lifecycle.state === "completed" || lifecycle.state === "cancelled")
        out.push({ type: "dropped", uuids });
      return out;
    }

    if (m.type === "system" && m.subtype === "init") {
      const problems = m.mcp_servers
        .filter((s) => s.status !== "connected")
        .map((s) => `The ${s.name} MCP server is ${s.status}.`);
      out.push({ type: "ready", sessionId: m.session_id, model: m.model, problems });
    } else if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "message_start") {
        this.current = e.message.id;
        this.calls.clear();
      } else if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
        // A long input (a board's HTML) takes a while to write: say what is coming meanwhile,
        // and what it is on as soon as the keys that name it are written.
        out.push({ type: "tool-start", id: e.content_block.id, name: e.content_block.name });
        this.calls.set(e.index, { id: e.content_block.id, input: new PartialInput() });
      } else if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
        const call = this.calls.get(e.index);
        if (call?.input.feed(e.delta.partial_json)) {
          const input = call.input.value();
          if (input) out.push({ type: "tool-input", id: call.id, input });
        }
      } else if (e.type === "content_block_stop") {
        this.calls.delete(e.index);
      } else if (
        e.type === "content_block_delta" &&
        e.delta.type === "text_delta" &&
        this.current
      ) {
        const text = (this.texts.get(this.current) ?? "") + e.delta.text;
        this.texts.set(this.current, text);
        out.push({ type: "text", id: this.current, text, done: false });
      } else if (e.type === "message_stop" && this.current) {
        const text = this.texts.get(this.current);
        if (text !== undefined) out.push({ type: "text", id: this.current, text, done: true });
        this.texts.delete(this.current);
        this.current = null;
      }
    } else if (m.type === "assistant" && !m.error) {
      for (const block of m.message.content) {
        if (block.type === "tool_use") {
          out.push({
            type: "tool",
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result")
          out.push({ type: "tool-done", id: block.tool_use_id, error: !!block.is_error });
      }
    } else if (m.type === "result") {
      out.push({
        type: "result",
        id: m.uuid,
        ok: !m.is_error,
        error: turnError(m),
        usage: Object.entries(m.modelUsage).map(([model, u]) => ({
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadInputTokens,
          cacheWriteTokens: u.cacheCreationInputTokens,
          costUsd: u.costUSD,
        })) satisfies ModelUsage[],
      });
    }
    return out;
  }
}

/**
 * Why a turn failed, or null when it did not. `is_error` is the only truth: an API failure
 * arrives as `subtype: "success"` with `is_error: true`.
 */
export function turnError(m: SDKResultMessage): TurnError | null {
  if (!m.is_error) return null;
  if (m.terminal_reason?.startsWith("aborted"))
    return { code: "interrupted", message: "The turn was stopped." };
  const status = m.subtype === "success" ? m.api_error_status : null;
  const said = (m.subtype === "success" ? m.result : m.errors.join(" ")) || "The turn failed.";
  if (status === 401 || status === 403)
    return { code: "claude_auth", message: "Claude refused the credential. Reconnect Claude." };
  if (status === 429) return { code: "claude_limit", message: said };
  if (status === 404) return { code: "model_unavailable", message: said };
  if (m.subtype === "error_max_turns") return { code: "max_turns", message: said };
  return { code: "turn_failed", message: said };
}

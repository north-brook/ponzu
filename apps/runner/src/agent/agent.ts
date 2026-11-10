import type { ToolResult } from "@ponzu/tools";
import type { z } from "zod";
import type { AskedQuestion, Effort, ModelUsage, RunErrorCode } from "../api/protocol.ts";

/*
 * The agent as the runner drives it: start one long-lived session, feed it messages, answer
 * what it asks, interrupt it, and read what it does as a stream of plain events. `ClaudeAgent`
 * (sdk.ts) is the one real implementation, on the Agent SDK; tests drive a scripted one. Nothing
 * outside agent/ knows the SDK.
 */

/** A tool the agent can call, as the runner hosts it in-process. */
export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  run(args: unknown): Promise<ToolResult>;
}

export interface AgentOptions {
  /** The repo's checkout, or Scratch's empty folder. */
  cwd: string;
  /** The session to pick up, or null to start one. */
  resume: string | null;
  model: string | null;
  effort: Effort | null;
  /** Appended to Claude Code's own system prompt. */
  instructions: string;
  /** Served to the agent as the `ponzu` MCP server. */
  tools: AgentTool[];
}

/** Something to put into the run. */
export interface AgentInput {
  /** Comes back in `taken` once the session holds it. */
  uuid: string;
  text: string;
  /**
   * `now`: into the running turn at once, interrupting it if need be. `next`: once the step
   * running now finishes, or as the next turn.
   */
  priority: "now" | "next";
  /** A person typed it, rather than the runner writing it for them. */
  human: boolean;
}

/** What the agent needs a person for. */
export type Ask =
  | { kind: "question"; questions: AskedQuestion[] }
  | { kind: "plan"; plan: string }
  | { kind: "permission"; tool: string; title: string; description: string | null };

/** A person's reply to an `Ask`. */
export interface Reply {
  /** For a question: each question's text to the answer. */
  answers?: Record<string, string>;
  /** For a plan or a permission. */
  approved?: boolean;
  note?: string;
}

export type AgentEvent =
  /** The session is up. */
  | { type: "ready"; sessionId: string; model: string; problems: string[] }
  /** These messages are now in the session's transcript. */
  | { type: "taken"; uuids: string[] }
  /** Claude Code is done with these messages. Any not taken by now never will be (a hook refused it). */
  | { type: "dropped"; uuids: string[] }
  /** The agent's text so far in one reply. `done` once the reply is complete. */
  | { type: "text"; id: string; text: string; done: boolean }
  /** The agent called a tool. */
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  /** A tool call's result is in the session. */
  | { type: "tool-done"; id: string; error: boolean }
  /** The agent waits on a person; answer with `reply` or take it back with `withdraw`. */
  | { type: "ask"; id: string; ask: Ask }
  /** The turn ended. `usage` is the session's running total, by model. */
  | { type: "result"; id: string; ok: boolean; error: TurnError | null; usage: ModelUsage[] }
  /** The session ended, on its own or by `close`. */
  | { type: "exit"; error: string | null };

export interface TurnError {
  /** `interrupted` when someone stopped it. */
  code: RunErrorCode | "interrupted";
  message: string;
}

export interface AgentRun extends AsyncIterable<AgentEvent> {
  send(input: AgentInput): void;
  reply(askId: string, reply: Reply): void;
  /** Take a question back unanswered: the agent hears that nobody will answer it. */
  withdraw(askId: string, reason: string): void;
  /** End the running turn. The session stays. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** What a session already holds, read from its transcript. */
export interface SessionHistory {
  /** The uuids of the messages put into it. */
  messages: Set<string>;
  /** The tool calls whose results are in it. */
  toolResults: Set<string>;
}

export interface Agent {
  start(opts: AgentOptions): AgentRun;
  /** What the session holds, or null when there is no such session to resume. */
  history(sessionId: string, cwd: string): Promise<SessionHistory | null>;
}

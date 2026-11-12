import type { ToolResult } from "@ponzu/tools";
import type { z } from "zod";
import type {
  AskedQuestion,
  Effort,
  ModelUsage,
  ReportedModel,
  RunErrorCode,
} from "../api/protocol.ts";
import type { Origin, TraceOptions, TurnSummary } from "./trace.ts";

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
  /** `call.id` is the tool call's id when Claude Code says it (an MCP request's `_meta`). */
  run(args: unknown, call?: { id?: string }): Promise<ToolResult>;
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
  /** Where each turn's trace goes (LLM analytics), or absent when analytics is off. */
  trace?: TraceOptions;
}

/** Something to put into the run. */
export interface AgentInput {
  /** Comes back in `taken` once the session holds it. */
  uuid: string;
  text: string;
  /**
   * `now`: into the running turn at once, interrupting it if need be. `next`: once the step
   * running now finishes, or as the next turn. `aside`: into the transcript without starting a
   * turn, for the agent to read with whatever starts the next one; only while no turn runs.
   */
  priority: "now" | "next" | "aside";
  /** A person typed it, rather than the runner writing it for them. */
  human: boolean;
  /** The event it carries, who sent it and from which app session: whose turn it begins. */
  origin?: Origin | null;
}

/** What the agent needs a person for. */
export type Ask =
  | { kind: "question"; questions: AskedQuestion[] }
  | { kind: "plan"; plan: string }
  | { kind: "permission"; tool: string; title: string; description: string | null }
  /**
   * An MCP server wants the person at a web address (a sign-in): opened in their browser, then
   * done there, or not now. The address is http or https.
   */
  | { kind: "handoff"; title: string; url: string; description: string | null };

/** A person's reply to an `Ask`. */
export interface Reply {
  /** For a question: each question's text to the answer. */
  answers?: Record<string, string>;
  /** For a plan or a permission; for a hand-off, done there. */
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
  /** The agent began writing a call to a tool: its input is still to come. */
  | { type: "tool-start"; id: string; name: string }
  /** More of a call's input is written: its complete members so far (the rest still to come). */
  | { type: "tool-input"; id: string; input: Record<string, unknown> }
  /** The agent called a tool. */
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  /** A tool call's result is in the session. */
  | { type: "tool-done"; id: string; error: boolean }
  /** The agent waits on a person; answer with `reply` or take it back with `withdraw`. */
  | { type: "ask"; id: string; ask: Ask }
  /**
   * An MCP server asked for something Ponzu can't show anyone (a form of fields), so it was
   * declined and Claude went on without it.
   */
  | { type: "declined"; server: string }
  /**
   * The turn ended. `usage` is the session's running total, by model; `turn` is when it began,
   * how many tools it called and which event began it, when the agent knows.
   */
  | {
      type: "result";
      id: string;
      ok: boolean;
      error: TurnError | null;
      usage: ModelUsage[];
      turn?: TurnSummary | null;
    }
  /** The session ended, on its own or by `close`. */
  | { type: "exit"; error: string | null }
  /**
   * Claude Code said something, whatever it was (a subagent's step, a stream's delta): it is not
   * stuck. At most about once a second.
   */
  | { type: "alive" };

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
  /**
   * What Claude Code offers the account it runs as, once the session has started; null when it
   * did not say. Asking sends nothing to Claude: the answer came with the session's start.
   */
  offered(): Promise<OfferedModels | null>;
}

/** What Claude Code offers, and which Claude Code says so (null when it did not say). */
export interface OfferedModels {
  claudeCode: string | null;
  models: ReportedModel[];
}

/** What a session already holds, read from its transcript. */
export interface SessionHistory {
  /** The uuids of the messages put into it. */
  messages: Set<string>;
  /**
   * The tool calls whose results are in it and went through: an answered question, not one
   * that was denied or taken back unanswered.
   */
  toolResults: Set<string>;
}

export interface Agent {
  start(opts: AgentOptions): AgentRun;
  /**
   * What the session holds, or null when there is no such session to resume. Found by id
   * alone: a session can be resumed from any working directory.
   */
  history(sessionId: string): Promise<SessionHistory | null>;
}

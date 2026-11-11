import type { ToolResult } from "@ponzu/tools";
import type { ModelUsage } from "../api/protocol.ts";
import type {
  Agent,
  AgentEvent,
  AgentInput,
  AgentOptions,
  AgentRun,
  Ask,
  Reply,
  SessionHistory,
  TurnError,
} from "./agent.ts";
import { Channel } from "./channel.ts";

/**
 * An agent a test drives by hand, for the runner's logic without Claude: each start is a
 * `ScriptedRun` the test makes say things, call the runner's real tools, ask questions and end
 * turns, while it records what the runner put in.
 */
export class ScriptedAgent implements Agent {
  readonly runs: ScriptedRun[] = [];
  /** What each session's transcript holds, for `history`. */
  readonly sessions = new Map<string, SessionHistory>();
  /** While set, reading a transcript fails with it, as with a disk that refuses. */
  historyError: Error | null = null;
  private started: ((run: ScriptedRun) => void)[] = [];

  start(opts: AgentOptions): AgentRun {
    const run = new ScriptedRun(opts);
    this.runs.push(run);
    for (const wake of this.started.splice(0)) wake(run);
    return run;
  }

  async history(sessionId: string): Promise<SessionHistory | null> {
    if (this.historyError) throw this.historyError;
    return this.sessions.get(sessionId) ?? null;
  }

  get last(): ScriptedRun {
    const run = this.runs.at(-1);
    if (!run) throw new Error("The agent has not been started.");
    return run;
  }

  /** The next run to start, or the last one if `count` have started already. */
  async run(count = 1): Promise<ScriptedRun> {
    while (this.runs.length < count) await new Promise<ScriptedRun>((r) => this.started.push(r));
    return this.runs[count - 1]!;
  }
}

export class ScriptedRun implements AgentRun {
  readonly inputs: AgentInput[] = [];
  readonly replies = new Map<string, Reply>();
  readonly withdrawn = new Map<string, string>();
  interrupts = 0;
  closed = false;
  private readonly out = new Channel<AgentEvent>();
  private waiters: (() => void)[] = [];
  private asked = new Map<string, (reply: Reply | null) => void>();
  private calls = 0;
  private seen = 0;

  constructor(readonly opts: AgentOptions) {}

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.out[Symbol.asyncIterator]();
  }

  send(input: AgentInput): void {
    this.inputs.push(input);
    for (const wake of this.waiters.splice(0)) wake();
  }

  reply(askId: string, reply: Reply): void {
    this.replies.set(askId, reply);
    this.asked.get(askId)?.(reply);
    this.asked.delete(askId);
  }

  withdraw(askId: string, reason: string): void {
    this.withdrawn.set(askId, reason);
    this.asked.get(askId)?.(null);
    this.asked.delete(askId);
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.out.push({ type: "exit", error: null });
    this.out.close();
  }

  emit(event: AgentEvent): void {
    this.out.push(event);
  }

  /** The `n`th input the runner put in (from 1), or the next one not asked for yet, once it is in. */
  async input(n = this.seen + 1): Promise<AgentInput> {
    this.seen = Math.max(this.seen, n);
    while (this.inputs.length < n) await new Promise<void>((r) => this.waiters.push(r));
    return this.inputs[n - 1]!;
  }

  ready(sessionId = "sess_1"): void {
    this.emit({ type: "ready", sessionId, model: "claude-test", problems: [] });
  }

  /** Claude Code took these inputs into the session. */
  take(...inputs: AgentInput[]): void {
    this.emit({ type: "taken", uuids: inputs.map((i) => i.uuid) });
  }

  say(id: string, text: string, done = true): void {
    this.emit({ type: "text", id, text, done });
  }

  /** Call one of the runner's tools, as Claude Code would through the MCP server. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const def = this.opts.tools.find((t) => t.name === name);
    if (!def) throw new Error(`No tool ${name}`);
    const id = `toolu_${++this.calls}`;
    this.emit({ type: "tool", id, name: `mcp__ponzu__${name}`, input: args });
    const result = await def.run(args);
    this.emit({ type: "tool-done", id, error: !!result.isError });
    return result;
  }

  /** Ask a person something; resolves to their reply, or null if it was withdrawn. */
  ask(id: string, ask: Ask): Promise<Reply | null> {
    return new Promise((resolve) => {
      this.asked.set(id, resolve);
      this.emit({ type: "tool", id, name: "AskUserQuestion", input: {} });
      this.emit({ type: "ask", id, ask });
    });
  }

  /** The ask's tool result is in the session. */
  answered(id: string): void {
    this.emit({ type: "tool-done", id, error: false });
  }

  end(opts: { error?: TurnError; usage?: ModelUsage[]; id?: string } = {}): void {
    this.emit({
      type: "result",
      id: opts.id ?? `res_${Math.random().toString(36).slice(2)}`,
      ok: !opts.error,
      error: opts.error ?? null,
      usage: opts.usage ?? [],
    });
  }

  crash(error = "Claude Code exited with code 1"): void {
    this.out.push({ type: "exit", error });
    this.out.close();
  }
}

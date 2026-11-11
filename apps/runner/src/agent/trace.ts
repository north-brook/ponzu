import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/*
 * Each turn of the agent as one trace in PostHog's LLM analytics (docs/analytics.md, "Agent
 * turns"), built from the Agent SDK's own message stream, in PostHog's documented event format
 * (https://posthog.com/docs/ai-observability/installation/manual-capture):
 *
 *   $ai_trace        the turn: its id is the turn's (the result's uuid, which the usage report
 *                    and the API's "turn finished" carry too), its latency, how it ended
 *   $ai_generation   each model call, the main agent's and every subagent's: model, tokens with
 *                    cache reads and writes, latency, time to first token, stop reason
 *   $ai_span         each tool call: name, how long, whether it failed
 *
 * A subagent's model calls and tools hang under the tool call that started it, so nothing it
 * did is lost and nothing is counted twice: a model call is one generation however many
 * messages the stream carried it in, and a tool call one span.
 *
 * `@posthog/ai` has a Claude Agent SDK integration, which this does not use: it fixes one
 * trace id for a whole query (Ponzu's is one long query per session, and its turn ids are the
 * result's), it cannot say per turn who sent the message or from which app session, and it
 * drops subagents' model calls (it reads only the main thread's stream).
 *
 * A turn's events are built and handed over when it ends, which is when its id is known; a
 * turn never waits on any of this. Prompts, replies and tool arguments and results go only when
 * `content` is on, each clipped (and scrubbed of secrets as they leave, in `telemetry.ts`);
 * otherwise those properties are null, as PostHog's privacy mode leaves them.
 */

/** One event for PostHog. `distinctId` null: about no one person. */
export interface AiEvent {
  event: "$ai_trace" | "$ai_generation" | "$ai_span";
  distinctId: string | null;
  properties: Record<string, unknown>;
  groups?: Record<string, string>;
}

/** Where a turn's events go once it ends. Must not throw or wait. */
export type TraceSink = (events: AiEvent[]) => void;

export interface TraceOptions {
  sink: TraceSink;
  /** Whether prompts, replies, tool arguments and results go with the events. */
  content: boolean;
  designId: string;
  workspaceId: string | null;
}

/** Who and what a message put into the run came from: the event, its sender and their session. */
export interface Origin {
  eventId: string;
  userId: string | null;
  sessionId: string | null;
}

/** What a turn was, as the runner reports it with its usage. */
export interface TurnSummary {
  startedAt: string;
  toolCalls: number;
  /** The event that began it, if one did. */
  eventId: string | null;
}

/** The most of one prompt, reply, argument or result kept, in characters. */
const MAX_TEXT = 16_000;
/** The most model calls and tool calls one turn's trace keeps; past these they are counted. */
const MAX_GENERATIONS = 400;
const MAX_SPANS = 1_000;

const PROVIDER = "anthropic";
const FRAMEWORK = "claude-agent-sdk";

type Message = { role: "user" | "assistant" | "system" | "tool"; content: unknown };

interface Generation {
  id: string;
  /** The tool call whose subagent made it, or null for the main agent. */
  parent: string | null;
  model: string | null;
  startedAt: number;
  firstTokenAt: number | null;
  endedAt: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  stopReason: string | null;
  prompt: Message[];
  reply: unknown[];
}

interface Span {
  id: string;
  name: string;
  /** The model call that asked for it. */
  parent: string | null;
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
  input: unknown;
  output: unknown;
}

interface Turn {
  startedAt: number;
  origin: Origin | null;
  generations: Map<string, Generation>;
  spans: Map<string, Span>;
  /** Every tool call's id, its subagents' included: how many it made, past `MAX_SPANS` too. */
  tools: Set<string>;
  dropped: number;
  /** What the next model call of each thread (main: "", a subagent: its tool call) is given. */
  pending: Map<string, Message[]>;
  /** The message each thread is streaming now. */
  streaming: Map<string, string>;
  lastReply: string | null;
}

export class TurnTrace {
  private turn: Turn | null = null;
  private readonly origins = new Map<string, Origin>();
  private readonly texts = new Map<string, string>();
  private readonly asides = new Set<string>();

  constructor(
    private readonly options: TraceOptions | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** A message going into the run, under `uuid`: who it came from, and what it says. */
  put(uuid: string, text: string, origin: Origin | null, aside: boolean): void {
    if (aside) this.asides.add(uuid);
    if (origin) this.origins.set(uuid, origin);
    if (this.options?.content) this.texts.set(uuid, text);
  }

  /** Reads one message of the stream. At a turn's end, what the turn was. */
  observe(m: SDKMessage): TurnSummary | null {
    const uuids = takenUuids(m);
    if (m.type === "result") {
      // A message put in aside ends with a result of its own, which is no turn.
      if (uuids.length && uuids.every((u) => this.asides.has(u))) {
        this.forget(uuids);
        return null;
      }
      const turn = this.turn ?? this.begin();
      this.take(turn, uuids);
      this.turn = null;
      const summary = {
        startedAt: new Date(turn.startedAt).toISOString(),
        toolCalls: turn.tools.size,
        eventId: turn.origin?.eventId ?? null,
      };
      this.emit(turn, {
        id: m.uuid,
        latency: m.duration_ms,
        error: m.is_error ? resultError(m) : null,
      });
      return summary;
    }
    if (uuids.length && !uuids.every((u) => this.asides.has(u))) this.take(this.current(), uuids);
    // Claude Code is done with a message it never took (a hook refused it, a stop cancelled
    // it): nothing will say whose it was. An aside stays known until its own result.
    const lifecycle = m as unknown as { type: string; command_uuid?: string; state?: string };
    if (
      lifecycle.type === "command_lifecycle" &&
      lifecycle.command_uuid &&
      (lifecycle.state === "completed" || lifecycle.state === "cancelled")
    ) {
      this.origins.delete(lifecycle.command_uuid);
      this.texts.delete(lifecycle.command_uuid);
    }

    if (m.type === "stream_event") {
      const thread = m.parent_tool_use_id ?? "";
      const e = m.event;
      if (e.type === "message_start") {
        const turn = this.current();
        const id = e.message.id;
        turn.streaming.set(thread, id);
        const generation = this.generation(turn, id, m.parent_tool_use_id);
        if (generation) {
          generation.model ??= e.message.model ?? null;
          absorbUsage(generation, e.message.usage);
        }
      } else if (this.turn) {
        const id = this.turn.streaming.get(thread);
        const generation = id ? this.turn.generations.get(id) : undefined;
        if (!generation) return null;
        if (e.type === "content_block_delta") generation.firstTokenAt ??= this.now();
        else if (e.type === "message_delta") {
          generation.stopReason = e.delta.stop_reason ?? generation.stopReason;
          absorbUsage(generation, e.usage);
        } else if (e.type === "message_stop") {
          generation.endedAt = this.now();
          this.turn.streaming.delete(thread);
        }
      }
    } else if (m.type === "assistant") {
      const turn = this.current();
      const message = m.message;
      const generation = this.generation(turn, message.id, m.parent_tool_use_id);
      if (!generation) return null;
      generation.model ??= message.model ?? null;
      // Without stream events, the message's own usage is all there is.
      absorbUsage(generation, message.usage);
      generation.stopReason = message.stop_reason ?? generation.stopReason;
      for (const block of message.content) {
        if (block.type === "tool_use") this.startSpan(turn, block, generation.id);
        if (this.options?.content && (block.type === "text" || block.type === "tool_use")) {
          generation.reply.push(
            block.type === "text"
              ? { type: "text", text: clip(block.text) }
              : {
                  type: "function",
                  function: { name: block.name, arguments: clipJson(block.input) },
                },
          );
        }
        if (block.type === "text" && !m.parent_tool_use_id) turn.lastReply = block.text;
      }
    } else if (m.type === "user" && this.turn) {
      const thread = m.parent_tool_use_id ?? "";
      const content = m.message.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const span = this.turn.spans.get(block.tool_use_id);
        if (span && span.endedAt === null) {
          span.endedAt = this.now();
          span.failed = block.is_error === true;
          if (this.options?.content) span.output = clipJson(block.content);
        }
      }
      if (this.options?.content) {
        this.pending(this.turn, thread).push({ role: "user", content: clipJson(content) });
      }
    }
    return null;
  }

  /**
   * The run ended without a result for the turn under way (Claude Code stopped, the runner is
   * closing): what it has goes out as a trace of its own, said to have ended unfinished.
   */
  abandon(): void {
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      this.emit(turn, {
        id: randomUUID(),
        latency: this.now() - turn.startedAt,
        error: "unfinished",
      });
    }
  }

  private current(): Turn {
    return this.turn ?? this.begin();
  }

  private begin(): Turn {
    this.turn = {
      startedAt: this.now(),
      origin: null,
      generations: new Map(),
      spans: new Map(),
      tools: new Set(),
      dropped: 0,
      pending: new Map(),
      streaming: new Map(),
      lastReply: null,
    };
    return this.turn;
  }

  /** Claude Code took these messages into the turn: the first with an origin says whose it is. */
  private take(turn: Turn, uuids: string[]): void {
    for (const uuid of uuids) {
      const origin = this.origins.get(uuid);
      if (origin && !turn.origin) turn.origin = origin;
      const text = this.texts.get(uuid);
      if (text !== undefined) this.pending(turn, "").push({ role: "user", content: clip(text) });
    }
    this.forget(uuids);
  }

  private forget(uuids: string[]): void {
    for (const uuid of uuids) {
      this.origins.delete(uuid);
      this.texts.delete(uuid);
      this.asides.delete(uuid);
    }
  }

  private pending(turn: Turn, thread: string): Message[] {
    const list = turn.pending.get(thread) ?? [];
    turn.pending.set(thread, list);
    return list;
  }

  /** The model call `id`, made the first time any message of it is seen. */
  private generation(turn: Turn, id: string, parent: string | null): Generation | null {
    const known = turn.generations.get(id);
    if (known) return known;
    if (turn.generations.size >= MAX_GENERATIONS) {
      turn.dropped++;
      return null;
    }
    const thread = parent ?? "";
    const generation: Generation = {
      id,
      parent,
      model: null,
      startedAt: this.now(),
      firstTokenAt: null,
      endedAt: null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      stopReason: null,
      // What came in since this thread's last call: the prompt, or the tools' results.
      prompt: turn.pending.get(thread)?.splice(0) ?? [],
      reply: [],
    };
    turn.generations.set(id, generation);
    return generation;
  }

  private startSpan(
    turn: Turn,
    block: { id: string; name: string; input: unknown },
    parent: string,
  ): void {
    if (turn.tools.has(block.id)) return;
    turn.tools.add(block.id);
    if (turn.spans.size >= MAX_SPANS) {
      turn.dropped++;
      return;
    }
    turn.spans.set(block.id, {
      id: block.id,
      name: block.name,
      parent,
      startedAt: this.now(),
      endedAt: null,
      failed: false,
      input: this.options?.content ? clipJson(block.input) : null,
      output: null,
    });
  }

  /** The turn's events, to the sink. Nothing here may reach the turn that made them. */
  private emit(turn: Turn, end: { id: string; latency: number; error: string | null }): void {
    const options = this.options;
    if (!options) return;
    try {
      const traceId = end.id;
      const person = turn.origin?.userId ?? null;
      const common = {
        $ai_trace_id: traceId,
        // A design's turns read as one conversation, whatever Claude session each ran in.
        $ai_session_id: options.designId,
        $ai_provider: PROVIDER,
        $ai_framework: FRAMEWORK,
        design_id: options.designId,
        ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
        ...(turn.origin?.sessionId ? { $session_id: turn.origin.sessionId } : {}),
        ...(person ? {} : { $process_person_profile: false }),
      };
      const groups = options.workspaceId ? { workspace: options.workspaceId } : undefined;
      const event = (name: AiEvent["event"], properties: Record<string, unknown>): AiEvent => ({
        event: name,
        distinctId: person,
        properties: { ...common, ...properties },
        ...(groups ? { groups } : {}),
      });
      const seconds = (from: number, to: number | null) =>
        to === null ? null : Math.max(0, to - from) / 1000;
      const content = options.content;

      const events: AiEvent[] = [];
      for (const g of turn.generations.values()) {
        events.push(
          event("$ai_generation", {
            $ai_span_id: g.id,
            $ai_parent_id: g.parent ?? traceId,
            $ai_span_name: g.parent ? "subagent" : "agent",
            $ai_model: g.model,
            $ai_input_tokens: g.input,
            $ai_output_tokens: g.output,
            $ai_cache_read_input_tokens: g.cacheRead,
            $ai_cache_creation_input_tokens: g.cacheWrite,
            $ai_latency: seconds(g.startedAt, g.endedAt),
            $ai_time_to_first_token: seconds(g.startedAt, g.firstTokenAt),
            $ai_stop_reason: g.stopReason,
            $ai_stream: true,
            $ai_input: content ? g.prompt : null,
            $ai_output_choices: content ? [{ role: "assistant", content: g.reply }] : null,
          }),
        );
      }
      for (const s of turn.spans.values()) {
        events.push(
          event("$ai_span", {
            $ai_span_id: s.id,
            $ai_parent_id: s.parent ?? traceId,
            $ai_span_name: s.name,
            $ai_latency: seconds(s.startedAt, s.endedAt ?? this.now()),
            $ai_is_error: s.failed,
            // A tool still running when the turn ended was cut off with it.
            ...(s.endedAt === null ? { unfinished: true } : {}),
            $ai_input_state: content ? s.input : null,
            $ai_output_state: content ? s.output : null,
          }),
        );
      }
      events.push(
        event("$ai_trace", {
          $ai_span_name: "turn",
          $ai_latency: end.latency / 1000,
          $ai_is_error: end.error !== null,
          ...(end.error ? { $ai_error: end.error } : {}),
          tool_calls: turn.tools.size,
          ...(turn.dropped ? { dropped: turn.dropped } : {}),
          $ai_input_state: content
            ? (turn.generations.values().next().value?.prompt ?? null)
            : null,
          $ai_output_state: content && turn.lastReply ? clip(turn.lastReply) : null,
        }),
      );
      options.sink(events);
    } catch {
      // Telemetry never reaches the turn.
    }
  }
}

/** The messages Claude Code says this one took into the session. */
function takenUuids(m: SDKMessage): string[] {
  const own = (m as { user_message_uuids?: string[] }).user_message_uuids ?? [];
  const lifecycle = m as unknown as { type: string; command_uuid?: string; state?: string };
  if (
    lifecycle.type === "command_lifecycle" &&
    lifecycle.command_uuid &&
    lifecycle.state === "started"
  ) {
    return [lifecycle.command_uuid];
  }
  return own;
}

/**
 * A usage report, as the stream and the messages carry it: the call's counts so far, which
 * only grow, so the largest seen is the call's.
 */
function absorbUsage(
  generation: Generation,
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | null
    | undefined,
): void {
  if (!usage) return;
  generation.input = Math.max(generation.input, usage.input_tokens ?? 0);
  generation.output = Math.max(generation.output, usage.output_tokens ?? 0);
  generation.cacheRead = Math.max(generation.cacheRead, usage.cache_read_input_tokens ?? 0);
  generation.cacheWrite = Math.max(generation.cacheWrite, usage.cache_creation_input_tokens ?? 0);
}

/** How a turn failed, by kind only: what Claude said is content, and stays out. */
function resultError(m: Extract<SDKMessage, { type: "result" }>): string {
  if (m.terminal_reason?.startsWith("aborted")) return "interrupted";
  if (m.subtype !== "success") return m.subtype;
  return m.api_error_status ? `api_error_${m.api_error_status}` : "error";
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** A value as it may go: strings clipped, the whole kept small, and never a throw. */
function clipJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return text.length > MAX_TEXT ? clip(text) : JSON.parse(text);
  } catch {
    return null;
  }
}

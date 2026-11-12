import { knownSecrets, redact, redactText } from "@ponzu/core/redact";
import type { Feedback } from "@ponzu/tools";
import { PostHog, type PostHogOptions } from "posthog-node";
import type { AiEvent } from "./agent/trace.ts";
import type { RunnerAnalytics } from "./api/protocol.ts";

/*
 * Where the runner sends its turns' traces: PostHog, directly, with the project token the API
 * handed it in the session (docs/analytics.md, "Agent turns"). The runner has the whole of
 * Claude Code's message stream; sending from here takes none of it through the API, whose
 * functions answer in 4.5 MB and whose region is a hundred milliseconds away. What the agent
 * says to the Ponzu team with send_feedback leaves the same way, as `agent feedback sent`.
 *
 * Nothing here is waited on by a turn: a capture goes on posthog-node's bounded queue, which
 * sends itself every few seconds. The runner flushes it, within a few seconds, as it gets ready
 * to sleep and as it stops, so what a turn did leaves before the machine does.
 */

export interface Telemetry {
  capture(events: AiEvent[]): void;
  /**
   * What the agent told the Ponzu team with send_feedback, as `agent feedback sent`. Queued like
   * a trace's events, and sent with them.
   */
  feedback(feedback: AgentFeedback): void;
  /** Sends what is queued. The runner bounds how long it waits. */
  flush(): Promise<void>;
  /** Sends what is queued and stops. */
  shutdown(): Promise<void>;
}

/** How posthog-node behaves in a sandbox. */
export const CLIENT_OPTIONS = {
  flushAt: 20,
  flushInterval: 5_000,
  // What may wait while PostHog is unreachable; past this the oldest is dropped.
  maxQueueSize: 1_000,
  requestTimeout: 5_000,
  fetchRetryCount: 2,
  fetchRetryDelay: 1_000,
  // The sandbox's address is the provider's, not the person's.
  disableGeoip: true,
  enableLocalEvaluation: false,
  disableRemoteConfig: true,
} satisfies PostHogOptions;

/**
 * The properties that carry what the agent saw and said, sent only when content is on. The rest
 * are ids, names and numbers, and some of their names (`$ai_input_tokens`) look like secrets'.
 */
const CONTENT = ["$ai_input", "$ai_output_choices", "$ai_input_state", "$ai_output_state"];

/** Deep enough for a tool's arguments inside a model call's prompt. */
const CONTENT_DEPTH = 32;

/** The event send_feedback becomes (docs/analytics.md, "Agent turns"). */
export const FEEDBACK_EVENT = "agent feedback sent";

/** The agent's feedback, and the canvas whose agent sent it. */
export interface AgentFeedback extends Feedback {
  canvasId: string;
  workspaceId: string | null;
}

/**
 * What `tool` must look like to be sent: a tool's name. The agent fills it in freely, and it goes
 * even with content off, so anything else (a sentence, a path) is dropped rather than sent.
 */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The properties of `agent feedback sent`. About no one person, like the API's events about no
 * one: the agent sent it, not whoever's message began the turn. The free text (`summary`,
 * `details`) goes only with content on, scrubbed of every secret `known` holds and of anything
 * that looks like one; with content off it is null, as a trace's content is.
 */
export function feedbackProperties(
  feedback: AgentFeedback,
  options: { content: boolean; known: readonly string[] },
): Record<string, unknown> {
  const text = (value: string | undefined) =>
    options.content && value ? redactText(value, options.known) : null;
  return {
    canvas_id: feedback.canvasId,
    ...(feedback.workspaceId ? { workspace_id: feedback.workspaceId } : {}),
    sentiment: feedback.sentiment,
    category: feedback.category,
    tool: feedback.tool && TOOL_NAME.test(feedback.tool) ? feedback.tool : null,
    summary: text(feedback.summary),
    details: text(feedback.details),
    $process_person_profile: false,
  };
}

export function posthogTelemetry(
  config: RunnerAnalytics,
  options: {
    fetch?: PostHogOptions["fetch"];
    log?: (message: string) => void;
    /**
     * Values taken out of the content wherever they appear: the repo's secrets and the Claude
     * credential, which the agent's environment holds and a command may print.
     */
    secrets?: readonly string[];
    /**
     * What this runner is (`runner/<version>+<bundle>`), put on every event as `ponzu_runner`, so
     * a trace says which build its turn ran on.
     */
    client?: string;
  } = {},
): Telemetry {
  // What a secret looks like, and every value known to be one, out of the content before it goes.
  // The list is read as each event goes: a secret given mid-turn joins it.
  const scrub = (properties: Record<string, unknown>) => {
    if (!config.content) return properties;
    const known = knownSecrets(options.secrets);
    const out = { ...properties };
    for (const name of CONTENT) {
      if (out[name] != null) out[name] = redact(out[name], { known, maxDepth: CONTENT_DEPTH });
    }
    return out;
  };
  const client = new PostHog(config.key, {
    ...CLIENT_OPTIONS,
    host: config.host,
    privacyMode: !config.content,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  client.on("error", (error) =>
    options.log?.(`posthog: ${error instanceof Error ? error.message : error}`),
  );
  return {
    capture(events) {
      for (const { event, distinctId, properties, groups } of events) {
        client.capture({
          event,
          // About no one person: kept off every profile, under the trace's own id.
          distinctId: distinctId ?? String(properties.$ai_trace_id),
          properties: {
            ...scrub(properties),
            ...(options.client ? { ponzu_runner: options.client } : {}),
          },
          ...(groups ? { groups } : {}),
        });
      }
    },
    feedback(feedback) {
      client.capture({
        event: FEEDBACK_EVENT,
        // About no one person: under the workspace, as the API keys its events about no one.
        distinctId: feedback.workspaceId ?? feedback.canvasId,
        properties: {
          ...feedbackProperties(feedback, { content: config.content, known }),
          ...(options.client ? { ponzu_runner: options.client } : {}),
        },
        ...(feedback.workspaceId ? { groups: { workspace: feedback.workspaceId } } : {}),
      });
    },
    flush: () => client.flush(),
    shutdown: () => client.shutdown(),
  };
}

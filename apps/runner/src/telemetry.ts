import { knownSecrets, redact } from "@ponzu/core/redact";
import { PostHog, type PostHogOptions } from "posthog-node";
import type { AiEvent } from "./agent/trace.ts";
import type { RunnerAnalytics } from "./api/protocol.ts";

/*
 * Where the runner sends its turns' traces: PostHog, directly, with the project token the API
 * handed it in the session (docs/analytics.md, "Agent turns"). The runner has the whole of
 * Claude Code's message stream; sending from here takes none of it through the API, whose
 * functions answer in 4.5 MB and whose region is a hundred milliseconds away.
 *
 * Nothing here is waited on by a turn: a capture goes on posthog-node's bounded queue, which
 * sends itself every few seconds. The runner flushes it, within a few seconds, as it gets ready
 * to sleep and as it stops, so what a turn did leaves before the machine does.
 */

export interface Telemetry {
  capture(events: AiEvent[]): void;
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
     * What this runner is (`runner/<version>+<image>`), put on every event as `ponzu_runner`, so
     * a trace says which image its turn ran on.
     */
    client?: string;
  } = {},
): Telemetry {
  const known = knownSecrets(options.secrets);
  // What a secret looks like, and every value known to be one, out of the content before it goes.
  const scrub = (properties: Record<string, unknown>) => {
    if (!config.content) return properties;
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
    flush: () => client.flush(),
    shutdown: () => client.shutdown(),
  };
}

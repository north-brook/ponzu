import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { PostHog, type PostHogOptions } from "posthog-node";
import type { Logger } from "../http/log.ts";
import { type AiTracing, createAiTracing, scopeContext } from "./ai.ts";
import { type Analytics, type AnalyticsSink, createAnalytics } from "./analytics.ts";

/*
 * PostHog, for a deployment: posthog-node for events, people, groups and exceptions, and
 * PostHog's span processor for model calls. Tuned for a function that may be frozen as soon
 * as it answers (PostHog's serverless guidance): nothing is sent from a timer, the queue is
 * sent by `createAnalytics` through `waitUntil` after each capture, and it is bounded, so
 * PostHog being slow or down costs memory up to a limit and nothing a person sees.
 */

export interface PosthogConfig {
  /** The project's token (`phc_…`): public, and the one thing that switches this on. */
  key: string;
  host: string;
  /** Whether model calls' prompts and answers are recorded (PONZU_POSTHOG_AI_CONTENT). */
  aiContent: boolean;
}

/** How posthog-node behaves here. Exported for the test that holds it to them. */
export const CLIENT_OPTIONS = {
  // Sent by `flush` from the request that captured; the timer is a backstop for long work.
  flushAt: 50,
  flushInterval: 10_000,
  // What may wait while PostHog is unreachable. Past this the oldest is dropped.
  maxQueueSize: 1_000,
  requestTimeout: 3_000,
  fetchRetryCount: 1,
  fetchRetryDelay: 500,
  // The API's address is Vercel's, not the person's: no location from it.
  disableGeoip: true,
  // Nothing here reads flags, and nothing should call PostHog to find out.
  enableLocalEvaluation: false,
  disableRemoteConfig: true,
} satisfies PostHogOptions;

/** The sink and tracing over a posthog-node client (and its `fetch`, for the test's sink). */
export function createPosthogSink(
  config: PosthogConfig,
  options: { fetch?: PostHogOptions["fetch"]; ai?: AiTracing } = {},
): { sink: AnalyticsSink; client: PostHog; ai: AiTracing } {
  const client = new PostHog(config.key, {
    ...CLIENT_OPTIONS,
    host: config.host,
    privacyMode: !config.aiContent,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const ai =
    options.ai ??
    createAiTracing({
      processor: new PostHogSpanProcessor({
        projectToken: config.key,
        host: config.host,
        privacyMode: !config.aiContent,
        client: scopeContext,
      }),
      content: config.aiContent,
    });
  const sink: AnalyticsSink = {
    capture: (message) => client.capture(message),
    identify: (distinctId, set, setOnce) =>
      client.identify({ distinctId, properties: { $set: set, $set_once: setOnce } }),
    group: (groupType, groupKey, properties) =>
      client.groupIdentify({ groupType, groupKey, properties }),
    exception: (error, distinctId, properties) =>
      client.captureException(error, distinctId ?? undefined, properties),
    flush: async () => {
      await Promise.all([client.flush(), ai.flush()]);
    },
  };
  return { sink, client, ai };
}

/**
 * The API's analytics: PostHog when there is a key, else nothing at all. `keep` is Vercel's
 * `waitUntil`, which holds the instance up until each send is done.
 */
export function createPosthogAnalytics(
  config: PosthogConfig | null,
  { keep, log }: { keep: (work: Promise<void>) => void; log: Logger },
): Analytics | null {
  if (!config) return null;
  const { sink, ai } = createPosthogSink(config);
  return createAnalytics({ sink, ai, keep, log });
}

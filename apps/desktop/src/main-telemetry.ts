import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import type { PosthogConfig } from "./config.ts";

/*
 * The main process's own error tracking (docs/analytics.md, "Errors"): its uncaught exceptions
 * and unhandled rejections, as PostHog `$exception`s, put down to whoever is signed in. Nothing
 * else is captured here; the studio captures what people do.
 *
 * It listens on `uncaughtExceptionMonitor` and nothing else, so it changes nothing about what
 * Electron does with an error: an `uncaughtException` listener (which posthog-node's
 * `enableExceptionAutocapture` installs) would silence Electron's own "A JavaScript error
 * occurred" dialog, and that autocapture exits the process on an error it calls fatal. An
 * unhandled rejection reaches the monitor too: Node's default turns it into an uncaught
 * exception, origin `unhandledRejection`.
 */

export interface MainTelemetry {
  /** For tests and for quitting: what an error would be reported as. */
  capture(error: unknown, origin: string): void;
  /** Send what's queued, giving up after `ms`. Never rejects. */
  shutdown(ms?: number): Promise<void>;
  /** Stop listening. */
  stop(): void;
}

/** The longest anything waits on PostHog: a quit is never held up longer. */
export const FLUSH_LIMIT_MS = 2000;

export function startMainTelemetry(opts: {
  posthog: PosthogConfig;
  /** On every exception: which app, version and computer. */
  properties: Record<string, string>;
  /** The signed-in person's Ponzu user id, or null. */
  userId: () => string | null;
  /** This person's home folder, which no path sent may name. */
  home: string;
  /** The network, for tests; the runtime's own otherwise. */
  fetch?: PostHogOptions["fetch"];
  process?: NodeJS.EventEmitter;
}): MainTelemetry {
  const client = new PostHog(opts.posthog.key, {
    host: opts.posthog.host,
    flushAt: 1,
    flushInterval: 5000,
    // Bounded: an error loop while PostHog is out of reach keeps the last few, and no more.
    maxQueueSize: 100,
    requestTimeout: 5000,
    fetchRetryCount: 1,
    before_send: (event) => (event ? scrubPaths(event, opts.home) : event),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // PostHog being away is never the person's problem.
  client.on("error", () => {});
  /** An id for this run's errors while nobody is signed in: no person is made of it. */
  const anonymous = randomUUID();
  const target = opts.process ?? process;

  const capture = (error: unknown, origin: string) => {
    try {
      const userId = opts.userId();
      client.captureException(error, userId ?? anonymous, {
        ...opts.properties,
        origin,
        ...(userId ? {} : { $process_person_profile: false }),
      });
    } catch {}
  };
  const monitor = (error: unknown, origin: string) => capture(error, origin);
  target.on("uncaughtExceptionMonitor", monitor);

  return {
    capture,
    async shutdown(ms = FLUSH_LIMIT_MS) {
      await Promise.race([
        client.shutdown(ms).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ms)),
      ]);
    },
    stop() {
      target.removeListener("uncaughtExceptionMonitor", monitor);
    },
  };
}

/**
 * The event with the person's home folder taken out of every string in it (a stack frame's file,
 * an error's message), as `~`. A packaged app runs from its bundle, but one in ~/Applications, a
 * development build, or an error about a file names the home folder, and with it the account.
 */
export function scrubPaths<T>(value: T, home: string): T {
  if (!home || home === "/") return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(home).join("~");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return walk(value) as T;
}

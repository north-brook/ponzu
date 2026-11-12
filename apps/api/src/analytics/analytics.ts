import { createHash } from "node:crypto";
import type { Logger } from "../http/log.ts";
import { redact } from "../http/log.ts";
import type { AiTracing } from "./ai.ts";
import type { ServerEvent, ServerEvents } from "./events.ts";
import { currentScope } from "./scope.ts";

/*
 * Product analytics, error tracking and model-call tracing, as the rest of the API sees them:
 * `deps.analytics.capture("canvas created", { … })` where the fact became true. This file
 * decides what a capture says (who it is about, which workspace, which app session) and makes
 * sure telemetry can never hurt the product. Where it goes is the sink's: PostHog in a
 * deployment (`posthog.ts`), an array under test.
 *
 * - Nothing here throws into product code, and nothing waits on the network: a capture is put
 *   on the sink's bounded queue, and the queue is sent in the background, kept alive past the
 *   response by `keep` (Vercel's `waitUntil`) and given at most `FLUSH_MS`.
 * - With no PostHog key there is no sink, and every call is a no-op (`noAnalytics`).
 */

/** The workspace group, as PostHog's group analytics names it. */
export const WORKSPACE_GROUP = "workspace";

/** The longest one send of the queue may keep a function instance alive. */
export const FLUSH_MS = 5_000;

/** What leaves for PostHog: one event, with whom and which workspace it is about. */
export interface Captured {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
  groups?: Record<string, string>;
  timestamp?: Date;
  uuid?: string;
}

/** What a person's PostHog profile says. */
export interface PersonProfile {
  userId: string;
  name: string | null;
  email: string | null;
  githubLogin: string;
  signedUpAt: Date;
}

/** What a workspace's group profile says: the GitHub account it is, and cheap true facts. */
export interface WorkspaceProfile {
  workspaceId: string;
  /** The GitHub account's login. */
  name: string;
  kind: "organization" | "user";
  repos: number;
  repositorySelection: string;
}

/** Where captures go. Every method must be cheap and must not wait on the network. */
export interface AnalyticsSink {
  capture(message: Captured): void;
  identify(
    distinctId: string,
    set: Record<string, unknown>,
    setOnce: Record<string, unknown>,
  ): void;
  group(groupType: string, groupKey: string, properties: Record<string, unknown>): void;
  exception(error: Error, distinctId: string | null, properties: Record<string, unknown>): void;
  /** Sends what is queued. May take as long as the network does: callers bound it. */
  flush(): Promise<void>;
}

export interface CaptureOptions {
  /**
   * Who the event is about, when the scope does not say or says someone else: a webhook's
   * job, the cron. Null for an event about no one (a sandbox the sweep put to sleep).
   */
  distinctId?: string | null;
  /** The workspace, when the scope does not know it. */
  workspaceId?: string | null;
  /** When it happened, for a fact reported after the moment it became true. */
  timestamp?: Date;
  /** The app session it came from, when the scope's request is not the one that sent it. */
  sessionId?: string | null;
  /**
   * The event's own id, for a fact that may be reported more than once (a runner's report sent
   * again): PostHog keeps one event per id. Make it with `stableUuid`, and pin `timestamp` too.
   */
  uuid?: string;
}

export interface Analytics {
  capture<E extends ServerEvent>(
    event: E,
    properties: ServerEvents[E],
    options?: CaptureOptions,
  ): void;
  /** Sets a person's profile: on sign-up and on every sign-in. */
  identify(person: PersonProfile): void;
  /** Sets a workspace's group profile: when it is connected and whenever it is read again. */
  group(workspace: WorkspaceProfile): void;
  /**
   * An error nobody expected: a 500, a failed background task or job. It goes to PostHog's
   * error tracking with the request's person, workspace, session, route and id, its message
   * and stack passed through the same redaction as the logs.
   */
  exception(error: unknown, properties?: Record<string, string | number | boolean | null>): void;
  /** How a model call is traced in LLM analytics, or null when analytics is off. */
  readonly ai: AiTracing | null;
  /** Sends what is queued now, within `FLUSH_MS`. For scripts and tests; requests need not. */
  flush(): Promise<void>;
  /**
   * Someone turned usage sharing on or off: this instance reads who has turned it off again at
   * its next send, rather than when its copy is a minute old.
   */
  sharingChanged(): void;
}

/** Analytics switched off: no PostHog key. Everything is a no-op. */
export const noAnalytics: Analytics = {
  capture: () => {},
  identify: () => {},
  group: () => {},
  exception: () => {},
  ai: null,
  flush: async () => {},
  sharingChanged: () => {},
};

/* ------------------------------------------------------------------ */
/* Share usage data                                                    */
/* ------------------------------------------------------------------ */

/** How long an instance keeps who has turned usage sharing off before it reads it again. */
export const OPT_OUTS_TTL_MS = 60_000;

/** The most captures held for the next send; past this the oldest is dropped. */
export const HELD_MAX = 1_000;

/**
 * Who has turned Settings › Account › Share usage data off (`users.share_usage`), as this
 * instance last read it.
 */
export interface OptOuts {
  /** The set, read again when the copy held is `OPT_OUTS_TTL_MS` old or was let go of. */
  current(): Promise<ReadonlySet<string>>;
  /** The copy held while it is fresh, without reading anything; null otherwise. */
  fresh(): ReadonlySet<string> | null;
  /** The copy held, fresh or not, without reading anything: null before the first read. */
  known(): ReadonlySet<string> | null;
  /** Lets go of the copy held, so the next `current` reads it again. */
  forget(): void;
}

/** Opt-outs read by `load` at most once a `ttlMs` (and once at a time), on `now`'s clock. */
export function cachedOptOuts(
  load: () => Promise<string[]>,
  now: () => number,
  ttlMs = OPT_OUTS_TTL_MS,
): OptOuts {
  let held: { ids: ReadonlySet<string>; at: number } | null = null;
  let stale = false;
  let reading: Promise<ReadonlySet<string>> | null = null;
  const fresh = () => (held && !stale && now() - held.at < ttlMs ? held.ids : null);
  return {
    fresh,
    current() {
      const ids = fresh();
      if (ids) return Promise.resolve(ids);
      reading ??= (async () => {
        try {
          const at = now();
          stale = false;
          const ids = new Set(await load());
          held = { ids, at };
          return ids;
        } finally {
          reading = null;
        }
      })();
      return reading;
    },
    known: () => held?.ids ?? null,
    forget: () => {
      stale = true;
    },
  };
}

/**
 * `sink`, leaving out what is about a person who has turned usage sharing off: their captures,
 * their profile and their errors. What is about no person (a workspace's group, an event about
 * no one) is untouched.
 *
 * Who has turned it off is read from the database only when the queue is sent, in the
 * background, never on the request path. A capture is checked against the copy this instance
 * holds while that copy is fresh; otherwise it is held here (at most `HELD_MAX`, the oldest
 * dropped first, each with the time it was captured) and handed to `sink` only once the send
 * has read the set again. If that read fails, the last copy decides, however old; with none
 * yet, everything waits for the next send. Nothing about an opted-out person is ever sent on a
 * guess.
 */
export function withoutOptedOut(
  sink: AnalyticsSink,
  optOuts: OptOuts,
  log?: Logger,
): AnalyticsSink {
  const held: { about: string; send: () => void }[] = [];
  const decide = (about: string | null, send: () => void) => {
    if (about === null) return send();
    const out = optOuts.fresh();
    if (out) {
      if (!out.has(about)) send();
      return;
    }
    held.push({ about, send });
    if (held.length > HELD_MAX) held.splice(0, held.length - HELD_MAX);
  };
  return {
    capture: (message) => {
      // An event about no one is keyed by its workspace or canvas, never a person.
      const about =
        message.properties.$process_person_profile === false ? null : message.distinctId;
      // One that is held would be stamped when it is sent: it keeps when it was captured.
      const sent =
        message.timestamp || about === null || optOuts.fresh()
          ? message
          : { ...message, timestamp: new Date() };
      decide(about, () => sink.capture(sent));
    },
    identify: (distinctId, set, setOnce) =>
      decide(distinctId, () => sink.identify(distinctId, set, setOnce)),
    group: (groupType, groupKey, properties) => sink.group(groupType, groupKey, properties),
    exception: (error, distinctId, properties) =>
      decide(distinctId, () => sink.exception(error, distinctId, properties)),
    async flush() {
      if (held.length > 0 || !optOuts.fresh()) {
        let out: ReadonlySet<string> | null;
        try {
          out = await optOuts.current();
        } catch (error) {
          log?.warn("analytics_opt_outs_unread", { error });
          out = optOuts.known();
        }
        if (out) {
          for (const { about, send } of held.splice(0)) {
            if (!out.has(about)) send();
          }
        }
      }
      await sink.flush();
    },
  };
}

/**
 * Analytics over `sink`. `keep` is handed each send of the queue so that something waits for
 * it: Vercel's `waitUntil` in a deployment, the test's background list under `createTestApp`.
 */
export function createAnalytics({
  sink: given,
  ai = null,
  keep,
  log,
  flushMs = FLUSH_MS,
  optOuts = null,
}: {
  sink: AnalyticsSink;
  ai?: AiTracing | null;
  keep: (work: Promise<void>) => void;
  log: Logger;
  /** How long one send may take: `FLUSH_MS`, shorter only in tests. */
  flushMs?: number;
  /** Who has turned usage sharing off: what is about them never reaches `sink`. */
  optOuts?: OptOuts | null;
}): Analytics {
  const sink = optOuts ? withoutOptedOut(given, optOuts, log) : given;
  let scheduled = false;
  const flush = () => bounded(sink.flush(), flushMs);
  /** One send for everything captured in this turn of the event loop. */
  const soon = () => {
    if (scheduled) return;
    scheduled = true;
    keep(
      Promise.resolve()
        .then(() => {
          scheduled = false;
          return flush();
        })
        .catch((error) => log.warn("analytics_flush_failed", { error })),
    );
  };
  /** Telemetry that fails is logged and goes no further: never into the request that called it. */
  const safely = (what: string, send: () => void) => {
    try {
      send();
      soon();
    } catch (error) {
      log.warn("analytics_failed", { what, error });
    }
  };

  return {
    capture(event, properties, options = {}) {
      safely(event, () => {
        const scope = currentScope();
        const workspaceId =
          options.workspaceId === undefined ? (scope?.workspaceId ?? null) : options.workspaceId;
        const person =
          options.distinctId === undefined ? (scope?.userId() ?? null) : options.distinctId;
        const about = (properties as { canvas_id?: string }).canvas_id ?? scope?.canvasId() ?? null;
        const sessionId =
          options.sessionId === undefined ? (scope?.sessionId ?? null) : options.sessionId;
        sink.capture({
          event,
          // Someone's, or nobody's: an event about no one is kept off every person's profile.
          distinctId: person ?? workspaceId ?? about ?? "ponzu-api",
          properties: {
            ...properties,
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
            ...(sessionId ? { $session_id: sessionId } : {}),
            ...(person ? {} : { $process_person_profile: false }),
          },
          ...(workspaceId ? { groups: { [WORKSPACE_GROUP]: workspaceId } } : {}),
          ...(options.timestamp ? { timestamp: options.timestamp } : {}),
          ...(options.uuid ? { uuid: options.uuid } : {}),
        });
      });
    },

    identify(person) {
      safely("identify", () =>
        sink.identify(
          person.userId,
          { name: person.name, email: person.email, github_login: person.githubLogin },
          { signed_up_at: person.signedUpAt.toISOString() },
        ),
      );
    },

    group(workspace) {
      safely("group", () =>
        sink.group(WORKSPACE_GROUP, workspace.workspaceId, {
          name: workspace.name,
          kind: workspace.kind,
          repos: workspace.repos,
          repository_selection: workspace.repositorySelection,
        }),
      );
    },

    exception(error, properties = {}) {
      safely("exception", () => {
        const scope = currentScope();
        const person = scope?.userId() ?? null;
        const canvasId = scope?.canvasId() ?? null;
        sink.exception(scrubbed(error), person, {
          ...properties,
          ...(scope
            ? {
                route: scope.route(),
                request_id: scope.requestId,
                ...(scope.workspaceId ? { workspace_id: scope.workspaceId } : {}),
                ...(canvasId ? { canvas_id: canvasId } : {}),
                ...(scope.sessionId ? { $session_id: scope.sessionId } : {}),
              }
            : {}),
          ...(scope?.workspaceId ? { $groups: { [WORKSPACE_GROUP]: scope.workspaceId } } : {}),
          ...(person ? {} : { $process_person_profile: false }),
        });
      });
    },

    ai,
    flush,
    sharingChanged: () => {
      if (!optOuts) return;
      optOuts.forget();
      // Read again in the background now, so what is captured next need not wait for it.
      soon();
    },
  };
}

/**
 * A UUID that is always the same for the same `name` (SHA-256 based, shaped as a version 8
 * UUID): an event's id for a fact that may be reported twice.
 */
export function stableUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The error as error tracking may see it: its name, its message and stack (and its causes')
 * with anything that looks like a secret taken out, as the logs do it.
 */
export function scrubbed(error: unknown, depth = 0): Error {
  if (!(error instanceof Error)) {
    return new Error(
      redact(
        typeof error === "string" ? error : "A value that was not an Error was thrown.",
      ) as string,
    );
  }
  const copy = new Error(redact(error.message) as string);
  copy.name = error.name;
  copy.stack = error.stack ? (redact(error.stack) as string) : undefined;
  if (error.cause !== undefined && depth < 4) copy.cause = scrubbed(error.cause, depth + 1);
  return copy;
}

/** `work`, or nothing after `ms`: a send that hangs never holds anything up past that. */
function bounded(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

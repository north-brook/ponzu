import { AsyncLocalStorage } from "node:async_hooks";

/*
 * Who and what a capture is about, without every call site saying so. A request runs inside
 * one scope (`analyticsScope`, the middleware), and so does everything it starts: the work it
 * hands to `deps.background` keeps the scope it was started in, because AsyncLocalStorage
 * follows promises. A webhook's job or the cron runs in none, and says who it is about itself.
 */

export interface AnalyticsScope {
  /** The signed-in person, once the route's access declaration has said who it is. */
  userId(): string | null;
  /** The design a runner acts on, for a runner's request. */
  designId(): string | null;
  /** The app's PostHog session (`X-POSTHOG-SESSION-ID`), so a recording links to what it did. */
  readonly sessionId: string | null;
  readonly requestId: string;
  /** The route as it was declared (`POST /v1/designs/:id/messages`), never the address asked. */
  route(): string;
  /** The workspace the request turned out to be about: the first one it was authorized for. */
  workspaceId: string | null;
}

const store = new AsyncLocalStorage<AnalyticsScope>();

/** Runs `fn` inside `scope`: every capture under it, now or later, is attributed by it. */
export function withScope<T>(scope: AnalyticsScope, fn: () => T): T {
  return store.run(scope, fn);
}

/** The scope this code runs in, if any. */
export function currentScope(): AnalyticsScope | undefined {
  return store.getStore();
}

/**
 * The app's PostHog session this request came from, or null: what an event row for the agent
 * keeps, so the turn it begins is traced under the same session.
 */
export function appSession(): string | null {
  return store.getStore()?.sessionId ?? null;
}

/**
 * Says which workspace the request is about. The authorization helpers call this as they hand
 * back a workspace's, a design's or a repo's row, which is where the API first knows it; the
 * first one wins, so a request that reads another workspace on the way stays with its own.
 */
export function noteWorkspace(workspaceId: string): void {
  const scope = store.getStore();
  if (scope && !scope.workspaceId) scope.workspaceId = workspaceId;
}

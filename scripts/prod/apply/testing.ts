/**
 * For the apply tests: a fake network that answers each vendor from a table of routes and keeps
 * every request it was sent, with its body, so a test can say exactly what apply wrote, and that
 * a dry run wrote nothing.
 */
import { loadInfra } from "../desired.ts";
import type { ApplyContext, WireRequest } from "./area.ts";

export interface Seen {
  method: string;
  /** Origin and path, without the query. */
  url: string;
  query: string;
  body: unknown;
  headers: Headers;
}

/** `"GET /v9/projects/ponzu-api"` → an answer (or a function of the request). */
export type Routes = Record<string, unknown | ((seen: Seen) => unknown)>;

/** An answer the fake gives as it is, with its status. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export function fakeNetwork(routes: Routes) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const entry: Seen = {
      method: request.method,
      url: `${url.origin}${url.pathname}`,
      query: url.search,
      body: text ? JSON.parse(text) : undefined,
      headers: request.headers,
    };
    seen.push(entry);
    const key = `${request.method} ${url.pathname}`;
    const route = key in routes ? routes[key] : undefined;
    if (route === undefined) {
      return new Response(JSON.stringify({ message: `no route for ${key}` }), {
        status: request.method === "GET" ? 404 : 500,
        headers: { "content-type": "application/json" },
      });
    }
    const answer = typeof route === "function" ? (route as (s: Seen) => unknown)(entry) : route;
    const reply = answer instanceof Reply ? answer : new Reply(200, answer);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    seen,
    /** Every request that was not a read. */
    writes: () => seen.filter((s) => s.method !== "GET" && s.method !== "HEAD"),
  };
}

export function applyContext(
  env: "dev" | "production",
  credentials: ApplyContext["credentials"],
  fetch: typeof globalThis.fetch,
  args: string[] = [],
): ApplyContext & { secrets: string[] } {
  const secrets: string[] = [];
  return {
    env,
    infra: loadInfra(),
    credentials,
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
    deep: false,
    args,
    secrets,
    secret: (value) => {
      secrets.push(value);
    },
  };
}

/** A planned request as the fake would have seen it: origin and path, query apart. */
export function asSeen(request: WireRequest) {
  const url = new URL(request.url);
  return {
    method: request.method,
    url: `${url.origin}${url.pathname}`,
    query: url.search,
    body: request.body,
  };
}

/** What the fake saw, in the same shape, for comparing with `asSeen`. */
export function written(seen: Seen[]) {
  return seen
    .filter((s) => s.method !== "GET")
    .map(({ method, url, query, body }) => ({ method, url, query, body }));
}

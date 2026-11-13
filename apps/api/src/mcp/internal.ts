import type { Context } from "hono";
import { asPerson } from "../auth/access.ts";
import type { UserActor } from "../auth/actor.ts";
import type { SelfFetch } from "../http/context.ts";

/*
 * The MCP acts as the person through the person's own routes: each tool that reads or changes
 * something asks the API itself, in this process, as them (`asPerson`). So an agent can do
 * exactly what the person's app could, held to the same access checks, gates, validation, rate
 * limits and analytics, and nothing the routes don't already say is written twice.
 *
 * Only these routes: the canvases, workspaces and the person's own profile. Never signing out,
 * deleting the account, connecting Claude, managing agents or anything else of the account's.
 */
const ALLOWED: readonly RegExp[] = [
  /^GET \/v1\/me$/,
  /^GET \/v1\/workspaces(\/[^/]+(\/canvases)?)?$/,
  /^POST \/v1\/canvases$/,
  /^(GET|PATCH) \/v1\/canvases\/[^/]+$/,
  /^GET \/v1\/canvases\/[^/]+\/(doc|thread|pull-requests?)$/,
  /^GET \/v1\/canvases\/[^/]+\/questions\/[^/]+$/,
  /^POST \/v1\/canvases\/[^/]+\/(messages|ops|stop|pull-requests)$/,
  /^POST \/v1\/canvases\/[^/]+\/questions\/[^/]+\/answer$/,
  /^DELETE \/v1\/canvases\/[^/]+\/pull-requests\/[^/]+\/[^/]+$/,
  /^(PUT|DELETE) \/v1\/canvases\/[^/]+\/driver$/,
];

/** A route said no: its code and its sentence, which the tool hands the agent as they are. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

/** The API, as the person, from inside one request to the MCP. */
export interface PersonApi {
  /** Answers the route's JSON, or null for a 204. Throws a `Refusal` for anything not 2xx. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  readonly actor: UserActor;
}

export function personApi(c: Context<any>, actor: UserActor, self: SelfFetch): PersonApi {
  const origin = new URL(c.req.url).origin;
  return {
    actor,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const pathname = path.split("?")[0]!;
      if (!ALLOWED.some((rule) => rule.test(`${method} ${pathname}`))) {
        throw new Error(`The MCP may not call ${method} ${pathname}.`);
      }
      const request = asPerson(
        new Request(`${origin}${path}`, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        actor,
      );
      const response = await self(request);
      if (response.status === 204) return null as T;
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = parsed?.error ?? {};
        throw new Refusal(
          response.status,
          String(error.code ?? "failed"),
          String(error.message ?? "Ponzu couldn't do that."),
          error.details,
        );
      }
      return parsed as T;
    },
  };
}

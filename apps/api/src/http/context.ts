import type { Actor } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import type { Logger } from "./log.ts";

/** The app's own `fetch`, for a request it makes to itself on a person's behalf (the MCP). */
export type SelfFetch = (request: Request) => Response | Promise<Response>;

/**
 * What every handler finds on its context (`c.var`). `actor` is typed as present only after
 * an `access` declaration that sets one, so a route cannot read it without asking for it.
 */
export type AppEnv = {
  Variables: {
    deps: Deps;
    requestId: string;
    /** Adds the request's id to every line. */
    log: Logger;
    actor?: Actor;
    /** The app itself, for the MCP's calls as the person (`mcp/internal.ts`). */
    self?: SelfFetch;
  };
};

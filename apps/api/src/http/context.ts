import type { Actor } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import type { Logger } from "./log.ts";

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
  };
};

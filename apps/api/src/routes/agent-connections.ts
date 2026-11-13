import {
  approveAgentAuthorization,
  denyAgentAuthorization,
  getOpenAgentAuthorization,
  listAgentGrants,
  listGrantDrivers,
  revokeAgentGrant,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { endDrive } from "../canvases/drive.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

/*
 * A person's own agents (docs/cloud.md, "Your own agent"): the ones they connected, and the
 * ask of one waiting for them in the app. Settings › Agents lists and revokes them; the app's
 * `<scheme>://agents/connect?request=<id>` link reads an ask and allows or refuses it.
 */

const GrantParams = z.object({ id: z.string().startsWith("agt_").max(64) });
const RequestParams = z.object({ id: z.string().startsWith("aga_").max(64) });

/** One of the person's connected agents. */
export const AgentConnection = z.object({
  id: z.string(),
  /** Its name as the person allowed it. */
  name: z.string(),
  /** What it last said it is when it called the MCP, as in `claude-code/2.1.0`. */
  client: z.string().nullable(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

/** An agent's ask, as the app shows it before the person decides. */
export const AgentRequest = z.object({
  id: z.string(),
  /** The name it registered with: its own word, which nothing checks. */
  name: z.string().nullable(),
  /** Where its code goes back to: the host of its redirect. */
  redirectHost: z.string(),
  /**
   * Whether that is this computer (a loopback address), as for an agent in a terminal. One that
   * isn't is a website or a service somewhere, and the app says so.
   */
  loopback: z.boolean(),
  expiresAt: z.date(),
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where the person's decision sends their browser: the agent's redirect, with its answer. */
const Decision = z.object({ redirectUrl: z.string() });

const ApproveBody = z.object({
  /** The name the app showed: kept on the grant as the person saw it. */
  name: z.string().min(1).max(60).optional(),
});

function redirectWith(
  { redirectUri, state }: { redirectUri: string; state: string | null },
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

const gone = () =>
  new ApiError(
    404,
    "not_found",
    "This request to connect an agent is over: it was answered, or 15 minutes passed. Ask the agent to connect again.",
  );

export const agentConnections = new Hono<AppEnv>()
  .use(access.user)

  .get("/", async (c) => {
    const { deps, actor } = c.var;
    const grants = await listAgentGrants(deps.db, actor.user.id);
    return c.json(
      z.array(AgentConnection).parse(
        grants.map((grant) => ({
          id: grant.id,
          name: grant.name,
          client: grant.lastClient,
          createdAt: grant.createdAt,
          lastUsedAt: grant.lastUsedAt,
        })),
      ),
    );
  })

  .delete("/:id", validate("param", GrantParams), async (c) => {
    const { deps, actor } = c.var;
    const { id } = c.req.valid("param");
    if (actor.agent) throw new ApiError(403, "forbidden", "An agent can't disconnect agents.");
    const revoked = await revokeAgentGrant(deps.db, { userId: actor.user.id, grantId: id });
    if (!revoked) throw new ApiError(404, "not_found", "There is no such connected agent.");
    // Whatever it drove goes back to Ponzu's agent.
    for (const canvasId of await listGrantDrivers(deps.db, id)) {
      await endDrive(
        { ...deps, log: c.var.log },
        { canvasId, how: "revoked", owner: actor.user, grantId: id },
      );
    }
    deps.analytics.capture("agent disconnected", {});
    return c.body(null, 204);
  })

  .get("/requests/:id", validate("param", RequestParams), async (c) => {
    const found = await getOpenAgentAuthorization(c.var.deps.db, c.req.valid("param").id);
    if (!found) throw gone();
    const host = new URL(found.redirectUri).host;
    return c.json(
      AgentRequest.parse({
        id: found.id,
        name: found.clientName,
        redirectHost: host,
        loopback: LOOPBACK.has(new URL(found.redirectUri).hostname),
        expiresAt: found.expiresAt,
      }),
    );
  })

  .post(
    "/requests/:id/approve",
    validate("param", RequestParams),
    validate("json", ApproveBody),
    async (c) => {
      const { deps, actor } = c.var;
      if (actor.agent) throw new ApiError(403, "forbidden", "An agent can't connect agents.");
      const { id } = c.req.valid("param");
      const asked = await getOpenAgentAuthorization(deps.db, id);
      if (!asked) throw gone();
      const name = c.req.valid("json").name ?? asked.clientName ?? "Your agent";
      const approved = await approveAgentAuthorization(deps.db, {
        id,
        userId: actor.user.id,
        name,
      });
      if (!approved) throw gone();
      deps.analytics.capture("agent connected", {});
      return c.json(
        Decision.parse({ redirectUrl: redirectWith(approved, { code: approved.code }) }),
      );
    },
  )

  .post("/requests/:id/deny", validate("param", RequestParams), async (c) => {
    const { deps, actor } = c.var;
    const denied = await denyAgentAuthorization(deps.db, {
      id: c.req.valid("param").id,
      userId: actor.user.id,
    });
    if (!denied) throw gone();
    return c.json(
      Decision.parse({
        redirectUrl: redirectWith(denied, {
          error: "access_denied",
          error_description: "The person didn't allow it.",
        }),
      }),
    );
  });

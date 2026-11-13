import { touchAgentGrant } from "@ponzu/db";
import { Hono } from "hono";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { personApi } from "../mcp/internal.ts";
import { handleMcp } from "../mcp/server.ts";
import { delegateTools } from "../mcp/tools.ts";

/*
 * `/v1/mcp`: Ponzu's MCP for a person's own agent (docs/cloud.md, "Your own agent"), over
 * Streamable HTTP without sessions. Only POST: there is no stream to open (GET) and no session
 * to end (DELETE). The agent's token is an MCP access token from Ponzu's OAuth
 * (`routes/oauth.ts`); a 401 says where to get one.
 */

/** The most one request to the MCP may carry: a tool call's arguments, an image's base64. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** What an agent says it is when it connects, as the grant keeps it: `claude-code/2.1.0`. */
function clientOf(body: unknown): string | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if ((message as { method?: unknown })?.method !== "initialize") continue;
    const info = (message as { params?: { clientInfo?: { name?: unknown; version?: unknown } } })
      .params?.clientInfo;
    if (typeof info?.name !== "string") return null;
    const name = info.name.replace(/[^\w.@ -]/g, "").slice(0, 60);
    const version =
      typeof info.version === "string" ? info.version.replace(/[^\w.+-]/g, "").slice(0, 30) : "";
    return name ? (version ? `${name}/${version}` : name) : null;
  }
  return null;
}

export const mcp = new Hono<AppEnv>()
  .post("/", access.agent, async (c) => {
    const { deps, actor } = c.var;
    const self = c.var.self;
    if (!self) throw new Error("The MCP needs the app to call.");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) {
      throw new ApiError(400, "invalid_request", "That request is too large for Ponzu's MCP.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(400, "invalid_request", "Send the MCP's JSON-RPC as JSON.");
    }
    const client = clientOf(body);
    if (client && actor.agent) {
      await touchAgentGrant(deps.db, { grantId: actor.agent.grantId, client });
    }
    return handleMcp(c.req.raw, {
      tools: delegateTools,
      version: deps.config.build.version,
      parsedBody: body,
      context: {
        api: personApi(c, actor, self),
        deps,
        signal: c.req.raw.signal,
      },
    });
  })
  .on(["GET", "DELETE"], "/", access.public, (c) => {
    c.header("allow", "POST");
    return c.json(
      { error: { code: "method_not_allowed", message: "Ponzu's MCP takes POST only." } },
      405,
    );
  });

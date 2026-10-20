import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SERVER_INSTRUCTIONS, tools, type Workspace } from "@ponzu/tools";
import { createMcpServer } from "./index.ts";

export interface BridgeOptions {
  name?: string;
  version?: string;
  /** Answers tool, guide and prompt listings, and runs tools when there's no host. */
  local: Workspace;
  /** Runs before each tool call that runs locally. */
  prepareLocal?: () => Promise<void>;
  /** The MCP URL of a running Ponzu host, or null. With `launch`, it may start one. */
  findHost: (launch: boolean) => Promise<string | null>;
  /** Runs after each new connection to a host. */
  onHost?: (url: string) => Promise<void>;
  /** Rewrite tool arguments before they run, e.g. relative paths to absolute. */
  mapArgs?: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
}

/** Longer than wait_for_activity's longest poll. */
const CALL_TIMEOUT = 15 * 60_000;
const readOnly = new Set(tools.filter((t) => t.readOnly).map((t) => t.name));

/**
 * MCP for agents that launch their own server (`ponzu mcp`). Tool calls go
 * to the running Ponzu host when there is one, so the agent shares its
 * canvas, selection and presence; without one they run against `local`.
 * Every call looks again, so the host can come and go mid-session.
 */
export async function serveBridge(
  opts: BridgeOptions,
  transport: Transport = new StdioServerTransport(),
) {
  const server = new Server(
    { name: opts.name ?? "ponzu", version: opts.version ?? "0.1.0", title: "Ponzu" },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} },
    },
  );
  // Our clients carry the agent's own name, so the canvas shows "Claude", not the bridge.
  const agent = () => {
    const info = server.getClientVersion();
    return { name: info?.name ?? "agent", version: info?.version ?? "0" };
  };

  let local: Promise<Client> | undefined;
  const localClient = () =>
    (local ??= (async () => {
      const client = new Client(agent());
      const [ours, theirs] = InMemoryTransport.createLinkedPair();
      await createMcpServer(opts.local).connect(theirs);
      await client.connect(ours);
      return client;
    })());

  interface Host {
    url: string;
    client: Client;
    transport: StreamableHTTPClientTransport;
    /** Calls still running on it. */
    busy: number;
    /** Replaced by another host: end the session once `busy` is 0. */
    retired: boolean;
  }
  let host: Host | null = null;
  const hosts = new Map<Client, Host>();
  // One attempt at a time of each kind; a listing's quick look never stands in for a launch.
  const connecting = new Map<boolean, Promise<Client | null>>();
  const dropHost = async (client: Client) => {
    hosts.delete(client);
    if (host?.client === client) host = null;
    await client.close().catch(() => {});
  };
  const endSession = async (h: Host) => {
    await h.transport.terminateSession().catch(() => {});
    await dropHost(h.client);
  };
  /** Run `fn` on a host client, so a retired host stays up until its calls finish. */
  const using = async <T>(client: Client, fn: () => Promise<T>): Promise<T> => {
    const h = hosts.get(client);
    if (h) h.busy++;
    try {
      return await fn();
    } finally {
      if (h && --h.busy === 0 && h.retired) void endSession(h);
    }
  };
  const connectHost = async (launch: boolean): Promise<Client | null> => {
    const url = await opts.findHost(launch).catch(() => null);
    if (!url) return null;
    const client = new Client(agent());
    const http = new StreamableHTTPClientTransport(new URL(url));
    // The host quit under an open stream. Closing rejects the pending calls instead of hanging them.
    client.onerror = (err) => {
      if (/SSE stream disconnected|reconnect/i.test(String(err))) void dropHost(client);
    };
    try {
      await client.connect(http);
    } catch {
      return null;
    }
    // Both kinds of attempt can land at once; keep one connection.
    if (host?.url === url) {
      await client.close().catch(() => {});
      return host.client;
    }
    if (host) retire(host);
    host = { url, client, transport: http, busy: 0, retired: false };
    hosts.set(client, host);
    client.onclose = () => {
      hosts.delete(client);
      if (host?.client === client) host = null;
    };
    await opts.onHost?.(url).catch(() => {});
    // The host may be a newer Ponzu than the last one (the app updated): have the agent list again.
    void server.sendToolListChanged().catch(() => {});
    return client;
  };
  const retire = (h: Host) => {
    if (h.retired) return;
    h.retired = true;
    if (host === h) host = null;
    if (h.busy === 0) void endSession(h);
  };
  const hostClient = async (launch = true): Promise<Client | null> => {
    const current = host;
    if (current) {
      // Another Ponzu may have taken over since, e.g. the app opened while `ponzu serve` ran.
      const announced = await opts.findHost(false).catch(() => null);
      // The probe was async: another call may have dropped or replaced `current` meanwhile.
      if (host && host !== current) return host.client;
      if (host === current && (!announced || announced === current.url)) return current.client;
      retire(current);
    }
    let pending = connecting.get(launch);
    if (!pending) {
      pending = connectHost(launch).finally(() => connecting.delete(launch));
      connecting.set(launch, pending);
    }
    return pending;
  };
  /**
   * Who answers listings: a running host, so an agent that started before an
   * app update still sees the new tools. Listing alone never starts the app.
   */
  const lister = async () => (await hostClient(false).catch(() => null)) ?? localClient();
  const list =
    <T>(fn: (c: Client, signal: AbortSignal) => Promise<T>) =>
    async (_req: unknown, extra: { signal: AbortSignal }): Promise<T> => {
      const client = await lister();
      try {
        return await using(client, () => fn(client, extra.signal));
      } catch (err) {
        if (client === (await local)) throw err;
        await dropHost(client);
        return fn(await localClient(), extra.signal);
      }
    };

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const params = { ...req.params, arguments: opts.mapArgs ? opts.mapArgs(name, args) : args };
    const options = { signal: extra.signal, timeout: CALL_TIMEOUT };
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await hostClient();
      if (!client) break;
      try {
        return await using(client, () =>
          client.request({ method: "tools/call", params }, CallToolResultSchema, options),
        );
      } catch (err) {
        // The host answered with an error: that's the answer.
        if (
          extra.signal.aborted ||
          (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed)
        )
          throw err;
        await dropHost(client);
        // Sending a write again could apply it twice if the host got it before it went away.
        if (!neverArrived(err) && !readOnly.has(name)) {
          return {
            content: [
              {
                type: "text",
                text: `Ponzu stopped while running ${name}, so it may or may not have applied. Check before trying again.`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    await opts.prepareLocal?.();
    return (await localClient()).request(
      { method: "tools/call", params },
      CallToolResultSchema,
      options,
    );
  });

  server.setRequestHandler(ListToolsRequestSchema, (req, extra) =>
    list((c, signal) => c.listTools(req.params, { signal }))(req, extra),
  );
  server.setRequestHandler(ListResourcesRequestSchema, (req, extra) =>
    list((c, signal) => c.listResources(req.params, { signal }))(req, extra),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req, extra) =>
    list((c, signal) => c.listResourceTemplates(req.params, { signal }))(req, extra),
  );
  server.setRequestHandler(ReadResourceRequestSchema, (req, extra) =>
    list((c, signal) => c.readResource(req.params, { signal }))(req, extra),
  );
  server.setRequestHandler(ListPromptsRequestSchema, (req, extra) =>
    list((c, signal) => c.listPrompts(req.params, { signal }))(req, extra),
  );
  server.setRequestHandler(GetPromptRequestSchema, (req, extra) =>
    list((c, signal) => c.getPrompt(req.params, { signal }))(req, extra),
  );

  await server.connect(transport);

  return {
    server,
    /** End the host session, so the canvas drops this agent, and stop serving. */
    async close() {
      host = null;
      for (const h of [...hosts.values()]) await endSession(h);
      if (local) await (await local).close().catch(() => {});
      await server.close();
    },
  };
}

/** True when a request failed before the host saw it, so sending it again is safe. */
function neverArrived(err: unknown): boolean {
  // 404: the host restarted and doesn't know our session.
  if (err instanceof StreamableHTTPError) return err.code === 404;
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return [e?.code, e?.cause?.code].some((c) => c === "ConnectionRefused" || c === "ECONNREFUSED");
}

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
  type CallToolRequest,
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
import { createMcpServer, FILES_META, ORIGIN_HEADERS, WAIT_META } from "./index.ts";

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
  /** The agent's working directory, shown in the studio's session card. */
  cwd?: string;
  /** RESTART_GRACE, for tests. */
  restartGrace?: number;
}

/** Longer than wait_for_activity's longest poll. */
const CALL_TIMEOUT = 15 * 60_000;
/**
 * How long a wait cut off by its host quitting looks for Ponzu to come back before starting it:
 * an update restarts it in seconds, and starting the old one meanwhile would stop the install.
 */
const RESTART_GRACE = 10_000;
const readOnly = new Set(tools.filter((t) => t.readOnly).map((t) => t.name));

/**
 * MCP for agents that launch their own server (`ponzu mcp`). Tool calls go
 * to the running Ponzu host when there is one, so the agent shares its
 * canvas and presence; without one they run against `local`.
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

  // Which agent this is, to every host it reaches, so a new connection resumes its session.
  const agentId = crypto.randomUUID();
  // The designs it has worked in, as the last answer said: a host that restarted starts from them.
  let files: string[] = [];
  const remember = (result: CallToolResult) => {
    const listed = result._meta?.[FILES_META];
    if (Array.isArray(listed) && listed.every((f) => typeof f === "string")) files = listed;
    return result;
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
    const http = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          [ORIGIN_HEADERS.via]: "bridge",
          [ORIGIN_HEADERS.agent]: agentId,
          ...(opts.cwd ? { [ORIGIN_HEADERS.cwd]: encodeURIComponent(opts.cwd) } : {}),
          ...(files.length
            ? { [ORIGIN_HEADERS.files]: encodeURIComponent(JSON.stringify(files)) }
            : {}),
        },
      },
    });
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

  /**
   * Look for a host to come back, without starting one, until `until` or RESTART_GRACE has passed.
   * True when one did.
   */
  const hostBack = async (until: number, signal: AbortSignal): Promise<boolean> => {
    const giveUp = Math.min(until, Date.now() + (opts.restartGrace ?? RESTART_GRACE));
    while (!signal.aborted) {
      if (await opts.findHost(false).catch(() => null)) return true;
      if (Date.now() >= giveUp) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  /**
   * A wait rides out Ponzu restarting under it, as when it quits into an update: once Ponzu is
   * back, it carries on there for the time it has left, rather than answering at once.
   */
  const waitThrough = async (
    params: CallToolRequest["params"],
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    const { since, timeout } = (params.arguments ?? {}) as { since?: unknown; timeout?: unknown };
    const deadline = Date.now() + (typeof timeout === "number" ? timeout : 60) * 1000;
    const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const withArgs = (more: Record<string, unknown>) => ({
      ...params,
      arguments: { ...params.arguments, ...more },
    });
    let cutOff = false;
    const result = await call(params, signal, async () => {
      cutOff = true;
      if (!(await hostBack(deadline, signal)) && Date.now() >= deadline) return null;
      return withArgs({ timeout: left() });
    });
    if (!result) {
      const again = typeof since === "number" ? `Wait again with cursor=${since}` : "Wait again";
      return {
        content: [
          {
            type: "text",
            text: `Ponzu stopped while you waited and isn't back yet, so nothing was checked. ${again}: it's most likely restarting into an update.`,
          },
        ],
      };
    }
    // Only a Ponzu answers a wait that was cut off: the one it came back to, or a new one started
    // once it didn't. It can't tell what happened before it started. With nothing waiting
    // on the agent, there's nothing to tell it: carry on from the new Ponzu's cursor.
    const wait = result._meta?.[WAIT_META] as { cursor: number; gap?: string; waiting?: number };
    if (!cutOff || wait?.gap !== "restart" || wait.waiting || !left()) return result;
    const again = (await call(withArgs({ since: wait.cursor, timeout: left() }), signal))!;
    const first = again.content.findIndex((c) => c.type === "text");
    return {
      ...again,
      content: again.content.map((c, i) =>
        i === first && c.type === "text"
          ? {
              ...c,
              text: `Ponzu restarted while you waited, with nothing waiting on you.\n${c.text}`,
            }
          : c,
      ),
    };
  };

  /**
   * Run a tool on the host, or else here. `cutOff`, for a read-only call, runs when the host went
   * away with it, and says what to send again: null answers null. A call cut off that way only
   * runs again on a host: never here, which can't tell what happened on the host meanwhile.
   */
  const call = async (
    params: CallToolRequest["params"],
    signal: AbortSignal,
    cutOff?: () => Promise<CallToolRequest["params"] | null>,
  ): Promise<CallToolResult | null> => {
    const name = params.name;
    let sent = params;
    let ridden = cutOff;
    const options = { signal, timeout: CALL_TIMEOUT };
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await hostClient();
      if (!client) break;
      try {
        return remember(
          await using(client, () =>
            client.request({ method: "tools/call", params: sent }, CallToolResultSchema, options),
          ),
        );
      } catch (err) {
        // The host answered with an error: that's the answer.
        if (signal.aborted || (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed))
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
        // A read-only call the host took with it: the caller says what to send again, if anything.
        if (ridden && !neverArrived(err)) {
          const next = await ridden();
          if (!next) return null;
          sent = next;
          ridden = undefined;
        }
      }
    }
    if (sent !== params) return null;
    await opts.prepareLocal?.();
    // Files it moves to while the host is down count too, for when the host comes back.
    return remember(
      await (await localClient()).request(
        { method: "tools/call", params: sent },
        CallToolResultSchema,
        options,
      ),
    );
  };

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const params = { ...req.params, arguments: opts.mapArgs ? opts.mapArgs(name, args) : args };
    if (name === "wait_for_activity") return waitThrough(params, extra.signal);
    return (await call(params, extra.signal))!;
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

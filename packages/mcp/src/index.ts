import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PresenceOrigin } from "@ponzu/core";
import {
  GUIDES,
  runTool,
  SERVER_INSTRUCTIONS,
  type ToolCaller,
  type ToolResult,
  type ToolSession,
  tools,
  type Workspace,
} from "@ponzu/tools";
import { z } from "zod";

export interface McpOptions {
  name?: string;
  version?: string;
  /** Who is calling. Filled from the client's name on initialize when omitted. */
  caller?: Partial<ToolCaller>;
}

/** Map an MCP client name to an agent icon. */
export function clientKind(name = ""): string {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("openai") || n.includes("chatgpt")) return "openai";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("gemini")) return "gemini";
  return "other";
}

function displayName(clientName = ""): string {
  const kind = clientKind(clientName);
  if (kind === "claude") return "Claude";
  if (kind === "openai") return "Codex";
  if (kind === "cursor") return "Cursor";
  if (kind === "gemini") return "Gemini";
  return clientName || "Agent";
}

/** One MCP server per agent connection, all sharing a Workspace. */
export function createMcpServer(ws: Workspace, opts: McpOptions = {}): McpServer {
  const server = new McpServer(
    { name: opts.name ?? "ponzu", version: opts.version ?? "0.1.0", title: "Ponzu" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );
  const id = opts.caller?.id ?? `agent_${Math.random().toString(36).slice(2, 8)}`;
  let caller: ToolCaller | null = opts.caller?.author ? (opts.caller as ToolCaller) : null;
  // Each connection keeps its own current file, so two agents never steer each other.
  const session: ToolSession = {};
  const getCaller = (): ToolCaller => {
    if (caller) return caller;
    const info = server.server.getClientVersion();
    caller = {
      id,
      author: { kind: "agent", name: displayName(info?.name) },
      client: clientKind(info?.name),
      reachedAt: opts.caller?.reachedAt,
      origin: {
        clientName: info?.name,
        clientVersion: info?.version,
        via: "http",
        ...opts.caller?.origin,
      },
    };
    return caller;
  };
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    ws.telemetry?.capture("agent connected", {
      client: clientKind(info?.name),
      client_name: info?.name,
      client_version: info?.version,
      // No caller: `ponzu mcp` running tools itself, with no host to join.
      via: opts.caller ? (opts.caller.origin?.via ?? "http") : "local",
    });
  };

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          title: def.title,
          readOnlyHint: def.readOnly ?? false,
          destructiveHint: def.destructive ?? false,
          openWorldHint: false,
        },
      },
      async (args: unknown, extra: { signal?: AbortSignal }) =>
        toMcp(await runTool(def, args, { ws, caller: getCaller(), signal: extra.signal, session })),
    );
  }

  for (const [topic, text] of Object.entries(GUIDES)) {
    server.registerResource(
      `guide-${topic}`,
      `ponzu://guide/${topic}`,
      { title: `Ponzu guide: ${topic}`, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }),
    );
  }

  server.registerPrompt(
    "iterate",
    {
      title: "Iterate on comments",
      description:
        "Watch the canvas: pick up comments as the person leaves them, make the changes, and resolve them.",
      argsSchema: { file: z.string().optional() },
    },
    ({ file }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Run the Ponzu iterate loop${file ? ` on ${file}` : ""}. Read get_guide('iterate'), then call wait_for_activity in a loop and handle each comment until I tell you to stop.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "design-brief",
    {
      title: "Start from a brief",
      description: "Turn a brief into tokens, a direction and first artboards.",
      argsSchema: { brief: z.string() },
    },
    ({ brief }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Design this in Ponzu: ${brief}\n\nRead get_guide('basics'). Write the brief and your direction to a note, set tokens, then build the first artboard in small pieces, screenshotting as you go. Offer two or three variations of the key screen side by side.`,
          },
        },
      ],
    }),
  );

  return server;
}

function toMcp(r: ToolResult) {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  for (const img of r.images ?? [])
    content.push({ type: "image", data: img.data, mimeType: img.mime });
  content.push({ type: "text", text: r.text });
  return { content, isError: r.isError };
}

/** Serve MCP over stdio (for `ponzu mcp` launched by an agent). */
export async function serveStdio(ws: Workspace, opts: McpOptions = {}): Promise<McpServer> {
  const server = createMcpServer(ws, opts);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Streamable HTTP handler with sessions. Mount it at /mcp:
 *   const mcp = createHttpHandler(ws); Bun.serve({ fetch: (req) => mcp(req) })
 * `mcp.idleMs()` is how long it's been since an agent last had a call running.
 */
export function createHttpHandler(
  ws: Workspace,
  opts: McpOptions & { onClose?: (callerId: string) => void } = {},
) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let running = 0;
  let lastActive = Date.now();
  // POSTs carry calls; a GET is a listening stream that stays open while the agent idles.
  const tracked = async (req: Request, res: Promise<Response>): Promise<Response> => {
    if (req.method !== "POST") return res;
    running++;
    const done = once(() => {
      running--;
      lastActive = Date.now();
    });
    try {
      return onBodyDone(await res, done);
    } catch (err) {
      done();
      throw err;
    }
  };
  const handle = (req: Request) => tracked(req, route(req));
  const route = async (req: Request): Promise<Response> => {
    const sid = req.headers.get("mcp-session-id");
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) return existing.handleRequest(req);
    if (sid) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found; reinitialize." },
          id: null,
        },
        { status: 404 },
      );
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const callerId = `agent_${crypto.randomUUID().slice(0, 8)}`;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        opts.onClose?.(callerId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      opts.onClose?.(callerId);
    };
    const server = createMcpServer(ws, {
      ...opts,
      // Links it hands the person use the address it reached us at, not this machine's localhost.
      caller: {
        id: callerId,
        ...opts.caller,
        origin: originFrom(req),
        reachedAt: new URL(req.url).origin,
      },
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
  const idleMs = () => (running > 0 ? 0 : Date.now() - lastActive);
  return Object.assign(handle, { idleMs });
}

/**
 * Headers `ponzu mcp` sends when it relays an agent to a running Ponzu, so
 * the studio can say where the session comes from. Display only: nothing
 * trusts them.
 */
export const ORIGIN_HEADERS = { via: "x-ponzu-via", cwd: "x-ponzu-cwd" } as const;

function originFrom(req: Request): PresenceOrigin | undefined {
  const via = req.headers.get(ORIGIN_HEADERS.via);
  const cwd = req.headers.get(ORIGIN_HEADERS.cwd);
  if (via !== "bridge") return undefined;
  try {
    return { via, ...(cwd ? { cwd: decodeURIComponent(cwd) } : {}) };
  } catch {
    // A malformed header loses the folder, never the session.
    return { via };
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/** Call `done` once the response body has been sent, or the client went away. */
function onBodyDone(res: Response, done: () => void): Response {
  if (!res.body) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          done();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

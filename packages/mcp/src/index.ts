import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PresenceOrigin } from "@ponzu/core";
import {
  GUIDES,
  runTool,
  SERVER_INSTRUCTIONS,
  SESSION_FILES,
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
  /** What this agent remembers between calls, when it outlives one connection. */
  session?: ToolSession;
  /** The agent was here before, on an earlier connection or an earlier Ponzu. */
  resumed?: boolean;
}

/** Where a tool result lists the designs its session has worked in, for a bridge to carry over. */
export const FILES_META = "ponzu.design/files";

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
  // Each agent keeps its own current file, so two agents never steer each other.
  const session: ToolSession = opts.session ?? {};
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
      resumed: opts.resumed ?? false,
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
        toMcp(
          await runTool(def, args, { ws, caller: getCaller(), signal: extra.signal, session }),
          session,
        ),
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
    "watch",
    {
      title: "Watch my comments",
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
            text: `Watch the Ponzu canvas${file ? ` for ${file}` : ""}. Read get_guide('watch'), then call wait_for_activity in a loop and handle each comment until I tell you to stop.`,
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
            text: `Design this in Ponzu: ${brief}\n\nRead get_guide('basics'). Write the brief and your direction to a note, set tokens, then build the first artboard in small pieces, screenshotting as you go. Offer two or three variations of the key screen side by side, then watch the canvas for my comments (get_guide('watch')).`,
          },
        },
      ],
    }),
  );

  return server;
}

function toMcp(r: ToolResult, session: ToolSession) {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  for (const img of r.images ?? [])
    content.push({ type: "image", data: img.data, mimeType: img.mime });
  content.push({ type: "text", text: r.text });
  const files = session.files?.length ? { _meta: { [FILES_META]: session.files } } : {};
  return { content, isError: r.isError, ...files };
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
 * `mcp.working()` is whether one has a call running that does work now: not
 * one only waiting for the person (wait_for_activity holds a call open for
 * minutes).
 */
export function createHttpHandler(
  ws: Workspace,
  opts: McpOptions & { onClose?: (callerId: string) => void } = {},
) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const agents = new Map<string, Agent>();
  let running = 0;
  let working = 0;
  let lastActive = Date.now();
  // POSTs carry calls; a GET is a listening stream that stays open while the agent idles.
  const tracked = async (req: Request, res: Promise<Response>): Promise<Response> => {
    if (req.method !== "POST") return res;
    const waits = await onlyWaits(req);
    running++;
    if (!waits) working++;
    const done = once(() => {
      running--;
      if (!waits) working--;
      lastActive = Date.now();
    });
    try {
      return onBodyDone(await res, done);
    } catch (err) {
      done();
      throw err;
    }
  };
  // The body is read twice: once here to see what it calls, once by the transport.
  const handle = (req: Request) => tracked(req, route(req.method === "POST" ? req.clone() : req));
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
    // A bridge names its agent, so a new connection (the stream dropped, Ponzu restarted) picks
    // up where the last left off: the same presence, the same file.
    const agentId = agentIdFrom(req);
    let agent = agentId ? agents.get(agentId) : undefined;
    let resumed = Boolean(agent);
    if (!agent) {
      const files = await reopen(ws, req.headers.get(ORIGIN_HEADERS.files));
      resumed = files.length > 0;
      agent = {
        callerId: `agent_${(agentId ?? crypto.randomUUID()).slice(0, 8)}`,
        session: files.length ? { file: files[0], files } : {},
        open: 0,
      };
      if (agentId) agents.set(agentId, agent);
    }
    const mine = agent;
    clearTimeout(mine.forget);
    mine.open++;
    // Gone once its last connection is: the canvas drops it, and its session is kept a while.
    const closed = once(() => {
      if (--mine.open > 0) return;
      opts.onClose?.(mine.callerId);
      if (!agentId) return;
      mine.forget = setTimeout(() => agents.delete(agentId), SESSION_KEEP);
      mine.forget.unref?.();
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        closed();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      closed();
    };
    const server = createMcpServer(ws, {
      ...opts,
      // Links it hands the person use the address it reached us at, not this machine's localhost.
      caller: {
        id: mine.callerId,
        ...opts.caller,
        origin: originFrom(req),
        reachedAt: new URL(req.url).origin,
      },
      session: mine.session,
      resumed,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
  const idleMs = () => (running > 0 ? 0 : Date.now() - lastActive);
  return Object.assign(handle, { idleMs, working: () => working > 0 });
}

/** Whether a POST only calls tools that wait for the person. */
export async function onlyWaits(req: Request): Promise<boolean> {
  try {
    const body = (await req.clone().json()) as unknown;
    const msgs = Array.isArray(body) ? body : [body];
    return (
      msgs.length > 0 &&
      msgs.every(
        (m) =>
          (m as { method?: string })?.method === "tools/call" &&
          WAITING_TOOLS.has((m as { params?: { name?: string } }).params?.name ?? ""),
      )
    );
  } catch {
    return false;
  }
}

const WAITING_TOOLS = new Set(["wait_for_activity"]);

/**
 * Headers `ponzu mcp` sends when it relays an agent to a running Ponzu: where
 * the session comes from, for the studio; which agent it is, so a new
 * connection resumes its session; and the designs it worked in, for a Ponzu
 * that restarted. Conveniences only: nothing trusts them, and calls still
 * check every file.
 */
export const ORIGIN_HEADERS = {
  via: "x-ponzu-via",
  cwd: "x-ponzu-cwd",
  agent: "x-ponzu-agent",
  files: "x-ponzu-files",
} as const;

/** How long an agent's session outlives its last connection, for one that comes back. */
const SESSION_KEEP = 10 * 60_000;

/** One agent behind one or more connections in a row. */
interface Agent {
  callerId: string;
  session: ToolSession;
  /** Its connections still open. */
  open: number;
  forget?: ReturnType<typeof setTimeout>;
}

function agentIdFrom(req: Request): string | undefined {
  const id = req.headers.get(ORIGIN_HEADERS.agent);
  return id && /^[\w-]{8,64}$/.test(id) ? id : undefined;
}

/** The designs a reconnecting agent worked in that this Ponzu has, or can open. */
async function reopen(ws: Workspace, header: string | null): Promise<string[]> {
  if (!header) return [];
  let listed: unknown;
  try {
    listed = JSON.parse(decodeURIComponent(header));
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const keys: string[] = [];
  for (const file of listed.slice(0, SESSION_FILES)) {
    if (typeof file !== "string") continue;
    try {
      const { key } = await ws.resolve(file);
      if (!keys.includes(key)) keys.push(key);
    } catch {
      // Moved or deleted since: it just isn't remembered.
    }
  }
  return keys;
}

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

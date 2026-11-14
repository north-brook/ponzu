import { timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { ApiError } from "./api/api.ts";
import type { GitCredentialRequest, GitCredentialResponse } from "./api/protocol.ts";

/**
 * The runner's one port. Vercel gives it a public `https://<sub>.vercel.run` address that anyone
 * with the URL can reach, so the runner checks the caller itself: every request carries
 * `authorization: Bearer <portToken>`, which the API handed this start of the runner (and only
 * this process holds; the agent's environment never has it). Even then nothing that arrives is
 * trusted: `POST /poke` says there may be something to claim, and the runner only claims, from
 * the API, with its own token. `GET /health` says it is up, and whether it has started.
 *
 * `POST /tool` runs one canvas tool for a person's own agent: `{ name, args, driver: { name,
 * client } }`, which only the API sends, relaying the agent's MCP call. It answers the tool's MCP
 * content. In tools mode (docs/cloud.md, "Driving a canvas") that is any canvas tool, for the
 * agent driving the canvas or one looking; beside Ponzu's agent, only one that looks ("Looking
 * without driving"). The bearer is the one door: only the API holds it, and the agent's own
 * checks (its grant, its lease, which tools it may call) are the API's.
 */
export function serve(opts: {
  port: number;
  /** The bearer every request must carry. */
  portToken: string;
  hostname?: string;
  poke(): void;
  health(): unknown;
  /** One canvas tool, for a person's own agent: any in tools mode, else one that looks. */
  tool?(name: string, args: unknown, driver: { name: string; client: string }): Promise<unknown>;
}): {
  port: number;
  stop(): void;
} {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch(request) {
      if (!bearerIs(request.headers.get("authorization"), opts.portToken))
        return new Response(null, { status: 401 });
      const { pathname } = new URL(request.url);
      if (pathname === "/poke") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        opts.poke();
        return new Response(null, { status: 204 });
      }
      if (pathname === "/health") {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        return Response.json(opts.health());
      }
      if (pathname === "/tool" && opts.tool) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        return answerTool(request, opts.tool);
      }
      return new Response(null, { status: 404 });
    },
  });
  return { port: server.port ?? opts.port, stop: () => void server.stop(true) };
}

/**
 * What git's credential helper (credential.ts) asks for, on a socket in the sandbox: `POST /get`
 * and `POST /erase` with git's request. The runner answers through its own lease and token, so
 * the agent's git needs neither. Whoever can open the socket can get a token for the canvas's
 * repository, which is what the agent's git is for; the file's group and mode say who that is.
 */
export function serveCredentials(opts: {
  path: string;
  get(ask: GitCredentialRequest): Promise<GitCredentialResponse>;
  erase(ask: GitCredentialRequest): Promise<void>;
}): { stop(): void } {
  // A runner that died leaves its socket behind, and a socket file in the way is EADDRINUSE.
  rmSync(opts.path, { force: true });
  const server = Bun.serve({
    unix: opts.path,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      try {
        const ask = (await request.json()) as GitCredentialRequest;
        if (pathname === "/get") return Response.json(await opts.get(ask));
        if (pathname === "/erase") {
          await opts.erase(ask);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(503, "unavailable", said(err));
        return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
      }
    },
  });
  // Owner and group: the runner and, in the image, the agent's user (the service's group).
  chmodSync(opts.path, 0o660);
  return { stop: () => void server.stop(true) };
}

/** A `POST /tool`: the call checked for its shape, run, and its answer or refusal as JSON. */
async function answerTool(
  request: Request,
  tool: NonNullable<Parameters<typeof serve>[0]["tool"]>,
): Promise<Response> {
  let body: { name?: unknown; args?: unknown; driver?: { name?: unknown; client?: unknown } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "The call isn't JSON." }, { status: 400 });
  }
  const { name, args, driver } = body ?? {};
  if (
    typeof name !== "string" ||
    typeof driver?.name !== "string" ||
    typeof driver.client !== "string"
  ) {
    return Response.json({ error: "Say which tool, and who drives." }, { status: 400 });
  }
  try {
    const answer = await tool(name, args ?? {}, { name: driver.name, client: driver.client });
    return Response.json(answer);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return Response.json(
      { error: said(err) },
      { status: typeof status === "number" && status >= 400 ? status : 500 },
    );
  }
}

/** Whether `header` is `Bearer <token>`, compared in constant time. */
function bearerIs(header: string | null, token: string): boolean {
  if (!header || !token) return false;
  const given = Buffer.from(header);
  const wanted = Buffer.from(`Bearer ${token}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

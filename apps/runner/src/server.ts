/**
 * The runner's one port, which the API reaches through the sandbox's token-gated address.
 * `POST /poke` says there may be something to claim, and carries nothing: whatever arrives,
 * the runner only claims, from the API, with its own token. `GET /health` says it is up.
 */
export function serve(opts: { port: number; hostname?: string; poke(): void; health(): unknown }): {
  port: number;
  stop(): void;
} {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch(request) {
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
      return new Response(null, { status: 404 });
    },
  });
  return { port: server.port ?? opts.port, stop: () => void server.stop(true) };
}

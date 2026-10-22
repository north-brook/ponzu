/*
 * The dev harness: builds the canvas, then serves dev.html (the app's part) with the built page
 * in a frame. Point it at a running Ponzu:
 *
 *   PONZU_TELEMETRY=0 bun apps/cli/src/index.ts serve examples/kettle.design --port 7791
 *   bun apps/mobile/canvas/dev.ts            # http://127.0.0.1:7792/?server=http://127.0.0.1:7791
 *
 * Every load of /canvas.html rebuilds, so a reload shows the latest source.
 */
import { join } from "node:path";

const here = import.meta.dir;
const port = Number(process.env.PORT ?? 7792);

async function build() {
  const proc = Bun.spawn(["bun", join(here, "build.ts")], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

await build();
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/")
      return new Response(Bun.file(join(here, "dev.html")), {
        headers: { "content-type": "text/html" },
      });
    if (pathname === "/canvas.html") {
      try {
        await build();
      } catch (err) {
        return new Response(String(err), { status: 500 });
      }
      return new Response(Bun.file(join(here, "dist/index.html")), {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      });
    }
    // The app fetches the catalog natively; a page can't read it across origins, so it's relayed.
    if (pathname === "/catalog") {
      const server = new URL(req.url).searchParams.get("server") ?? "http://127.0.0.1:7791";
      return fetch(`${server}/api/catalog`);
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`canvas harness: http://127.0.0.1:${server.port}/?server=http://127.0.0.1:7791`);

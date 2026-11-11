/*
 * What the studio's end-to-end tests share: the app built as the desktop package builds it,
 * served as the desktop's scheme serves it, and waiting on something the page can't announce.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUDIO } from "../../scripts/visual-lib.ts";

/**
 * Builds the app as the desktop package does, into a fresh directory. `e2e` keeps Ponzu Cloud in
 * memory in, which a production build leaves out.
 */
export async function buildApp(mode: "e2e" | "production"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-studio-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--mode", mode, "--outDir", dir], {
    cwd: STUDIO,
    // bun test sets NODE_ENV=test, which a packaging build never has.
    env: { ...process.env, NODE_ENV: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`The studio didn't build:\n${await new Response(build.stderr).text()}`);
  }
  return dir;
}

/** Serves the built app with its routes falling back to index.html, as the desktop's scheme does. */
export function serve(dir: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = Bun.file(join(dir, path));
      return path !== "/" && (await file.exists())
        ? new Response(file)
        : new Response(Bun.file(join(dir, "index.html")));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

export async function waitUntil(done: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Gave up waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

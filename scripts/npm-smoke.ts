/**
 * Install the npm package that scripts/npm-package.ts built, as `bunx ponzu`
 * would, and check it works outside the monorepo: it reports its version,
 * creates a design, serves it with the studio, and finds the renderer
 * wherever this machine has a Chrome. Nothing touches ~/.ponzu or the app.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "../packages/render/src/chromium.ts";

const pkg = join(import.meta.dir, "../apps/cli/npm");
const dir = await mkdtemp(join(tmpdir(), "ponzu-npm-"));
const env = {
  ...process.env,
  PONZU_HOME: join(dir, "home"),
  PONZU_APP: "none",
  PONZU_TELEMETRY: "0",
  PONZU_TAILSCALE: "none",
  PONZU_SPOTLIGHT: "0",
};

function run(cmd: string[], cwd = dir): string {
  const out = Bun.spawnSync(cmd, { cwd, env, stderr: "pipe" });
  if (out.exitCode !== 0)
    fail(
      `${cmd.join(" ")} exited ${out.exitCode}\n${out.stderr.toString()}${out.stdout.toString()}`,
    );
  return out.stdout.toString().trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
try {
  const tarball = run(["npm", "pack", "--silent", "--pack-destination", dir], pkg)
    .split("\n")
    .pop()!;
  await Bun.write(join(dir, "package.json"), "{}");
  run(["bun", "add", join(dir, tarball)]);
  const ponzu = join(dir, "node_modules/.bin/ponzu");

  const version = run([ponzu, "--version"]);
  const expected = (await Bun.file(join(pkg, "package.json")).json()).version;
  if (version !== expected) fail(`ponzu --version said ${version}, not ${expected}`);

  run([ponzu, "init", "smoke.design"]);

  const port = 7700 + Math.floor(Math.random() * 90);
  server = Bun.spawn([ponzu, "serve", "smoke.design", "--no-open", "--port", String(port)], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  let info: { mcp?: string } | null = null;
  for (let i = 0; i < 80 && !info; i++) {
    await Bun.sleep(250);
    info = await fetch(`${base}/api/info`)
      .then((r) => (r.ok ? (r.json() as Promise<{ mcp?: string }>) : null))
      .catch(() => null);
  }
  if (!info?.mcp) fail("ponzu serve never answered /api/info");
  const page = await fetch(base).then((r) => r.text());
  if (!page.includes(`<div id="root"`)) fail("ponzu serve didn't serve the studio");

  server.kill();
  const log = await new Response(server.stdout).text();
  if (findChromium() && log.includes("No Chrome or Chromium found"))
    fail(`The package couldn't load its renderer:\n${log}`);
  console.log(`ponzu ${version} installs, creates a design and serves the studio.`);
} finally {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
}

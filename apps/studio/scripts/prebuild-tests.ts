/*
 * Builds, at once, the three studios the Chromium tests serve, into `<root>/gallery`,
 * `<root>/e2e` and `<root>/production`, each with its stamp (scripts/prebuilt.ts). CI runs this
 * before `bun test` with PONZU_PREBUILT_STUDIO=<root>, so the test files that serve one share
 * three builds instead of each making its own:
 *
 *   bun apps/studio/scripts/prebuild-tests.ts "$RUNNER_TEMP/studio-tests"
 *
 * Each is built exactly as the helper it stands in for builds it: the gallery as buildGallery
 * does under `bun test` (NODE_ENV=test), the app as buildApp does (no NODE_ENV).
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { KINDS, type Kind } from "./prebuilt.ts";

const STUDIO = resolve(import.meta.dir, "..");

const root = process.argv[2];
if (!root) {
  console.error("Usage: bun apps/studio/scripts/prebuild-tests.ts <directory>");
  process.exit(2);
}

async function build(kind: Kind) {
  const dir = join(resolve(root!), kind);
  rmSync(dir, { recursive: true, force: true });
  const started = performance.now();
  const env: Record<string, string | undefined> = { ...process.env, PONZU_PREBUILT_KIND: kind };
  if (kind === "gallery") env.NODE_ENV = "test";
  else delete env.NODE_ENV;
  const config = join(STUDIO, "scripts/prebuild.vite.config.ts");
  const proc = Bun.spawn(
    ["bunx", "vite", "build", "--config", config, "--mode", kind, "--outDir", dir],
    { cwd: STUDIO, env, stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    throw new Error(`The ${kind} build failed:\n${out}`);
  }
  console.log(`${kind}: ${dir} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

await Promise.all(KINDS.map(build));

#!/usr/bin/env bun
/**
 * What the sandbox image installs, in apps/runner/dist:
 *
 *   runner.js              the runner, bundled with everything but playwright-core
 *   git-credential.js      git's credential helper for github.com
 *   supervise.js           what starts the runner, restarts it and stops it (no systemd)
 *   package.json           playwright-core, at the version the renderer was built against
 *
 * The image runs `bun install --production` in the directory, then `bun runner.js` on its own
 * Bun (1.3 or later) on Linux. Claude Code is the image's own binary, not a copy the Agent SDK
 * would download, and Chromium is Playwright's headless shell (README.md).
 *
 *   bun run build                  from apps/runner
 *   bun scripts/build.ts --smoke   also starts the bundle, which must refuse an empty environment
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [entry, name] of [
  ["src/main.ts", "runner.js"],
  ["src/credential.ts", "git-credential.js"],
  ["src/supervise.ts", "supervise.js"],
] as const) {
  const built = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "bun",
    format: "esm",
    minify: { syntax: true, whitespace: true },
    sourcemap: "linked",
    naming: name,
    outdir: out,
    // It finds its own files at run time, so it cannot be bundled.
    external: ["playwright-core"],
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
}

// The version the renderer resolved, as the lockfile has it.
const render = join(root, "..", "..", "packages", "render");
const playwright = JSON.parse(
  readFileSync(Bun.resolveSync("playwright-core/package.json", render), "utf8"),
);
const manifest = {
  name: "ponzu-runner",
  private: true,
  type: "module",
  dependencies: { "playwright-core": playwright.version },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${out}`);

if (process.argv.includes("--smoke")) {
  // Loading the bundle reaches every module it holds. With no environment it must stop at
  // once, with the status the supervisor does not restart on.
  const run = spawnSync(process.execPath, [join(out, "runner.js")], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.status !== 78 || !run.stderr.startsWith("[runner]")) {
    console.error(`The bundle did not start as it should (exit ${run.status}):\n${run.stderr}`);
    process.exit(1);
  }
  console.log("the bundle loads, and refuses to start without its environment");
}

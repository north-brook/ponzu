#!/usr/bin/env bun
/**
 * The runner bundle (src/bundle.ts), in <outdir> (apps/runner/dist by default):
 *
 *   runner.js              the runner, bundled with everything but playwright-core, which the
 *                          image has at /opt/ponzu/node_modules
 *   supervise.js           what starts the runner, restarts it and stops it (no systemd)
 *   git-credential.js      git's credential helper for github.com
 *   manifest.json          what the bundle needs of the image: Claude Code and playwright-core
 *   runner.tgz             those four, packed the same way every time (tgz.ts)
 *   bundle.json            { sha256, requires, tgz }: what the API serves and names at a start
 *
 * What the bundle needs comes only from the runner's own dependencies (the Agent SDK's
 * `claudeCodeVersion`, the renderer's playwright-core); this reads nothing of the image. The
 * image's `bundle-fits` checks it against what the image installed.
 *
 *   bun run build                                   from apps/runner
 *   bun scripts/build.ts --outdir <dir>             somewhere else; dist/ is left alone
 *   bun scripts/build.ts --smoke                    also starts the bundle, which must refuse an
 *                                                   empty environment
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerBundle, RunnerManifest } from "../src/bundle.ts";
import { tgz } from "./tgz.ts";

const root = join(import.meta.dir, "..");

/** `--outdir <dir>` or `--outdir=<dir>`, from where it is run; dist/ without one. */
function outdir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--outdir") {
      const dir = argv[i + 1];
      if (!dir || dir.startsWith("--")) throw new Error("--outdir needs a directory.");
      return resolve(dir);
    }
    if (arg.startsWith("--outdir=")) return resolve(arg.slice("--outdir=".length));
  }
  return join(root, "dist");
}

const out = outdir(process.argv.slice(2));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ENTRIES = [
  ["src/main.ts", "runner.js"],
  ["src/supervise.ts", "supervise.js"],
  ["src/credential.ts", "git-credential.js"],
] as const;

for (const [entry, name] of ENTRIES) {
  const built = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "bun",
    format: "esm",
    // Names stay, so a stack trace in the runner's log still reads.
    minify: { syntax: true, whitespace: true },
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

const packageJson = (name: string, from: string) =>
  JSON.parse(readFileSync(Bun.resolveSync(`${name}/package.json`, from), "utf8"));

// The Claude Code the Agent SDK was built against, and the playwright-core the renderer
// resolved, as the lockfile has them.
const sdk = packageJson("@anthropic-ai/claude-agent-sdk", root);
const playwright = packageJson("playwright-core", join(root, "..", "..", "packages", "render"));
if (typeof sdk.claudeCodeVersion !== "string")
  throw new Error("The Agent SDK's package.json has no claudeCodeVersion.");
const requires: RunnerBundle["requires"] = {
  claude: sdk.claudeCodeVersion,
  playwrightCore: playwright.version,
};

const files = ENTRIES.map(([, name]) => name);
const manifest: RunnerManifest = {
  name: "ponzu-runner",
  version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  requires,
  files,
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const packed = tgz(
  [...files, "manifest.json"].map((name) => ({ name, bytes: readFileSync(join(out, name)) })),
);
const sha256 = createHash("sha256").update(packed).digest("hex");
writeFileSync(join(out, "runner.tgz"), packed);
const bundle: RunnerBundle = { sha256, requires, tgz: Buffer.from(packed).toString("base64") };
writeFileSync(join(out, "bundle.json"), `${JSON.stringify(bundle)}\n`);
console.log(
  `built ${out}: runner bundle ${sha256.slice(0, 12)}, ${packed.length} bytes, for Claude Code ${requires.claude} and playwright-core ${requires.playwrightCore}`,
);

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

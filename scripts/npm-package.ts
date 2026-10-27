/**
 * Build the `ponzu` package for npm into apps/cli/npm, which `bunx ponzu`
 * runs. The CLI is bundled into one file for Bun, with the Chromium renderer
 * beside it (loaded only to take screenshots, so Playwright stays out of
 * startup) and the studio it serves. Build the studio first:
 *
 *   bun run --filter @ponzu/studio build && bun scripts/npm-package.ts
 *
 * Release builds pass PONZU_POSTHOG_KEY, inlined as in the Mac app's server.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "apps/cli/npm");
const studio = join(root, "apps/studio/dist");

const cli = (await Bun.file(join(root, "apps/cli/package.json")).json()) as {
  version: string;
  description: string;
};
const render = (await Bun.file(join(root, "packages/render/package.json")).json()) as {
  dependencies: Record<string, string>;
};

if (!existsSync(join(studio, "index.html"))) {
  console.error("Build the studio first: bun run --filter @ponzu/studio build");
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
const built = await Bun.build({
  entrypoints: [join(root, "apps/cli/src/index.ts"), join(root, "packages/render/src/chromium.ts")],
  outdir: join(out, "dist"),
  naming: "[name].[ext]",
  target: "bun",
  // Playwright installs as a dependency; the others are optional imports of
  // dependencies that Ponzu never takes, as in the Mac app's server.
  external: ["playwright-core", "@opentelemetry/api", "rxjs"],
  env: "PONZU_POSTHOG_*",
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

await cp(studio, join(out, "studio"), { recursive: true });
await cp(join(root, "README.md"), join(out, "README.md"));
await cp(join(root, "LICENSE"), join(out, "LICENSE"));

const manifest = {
  name: "ponzu",
  version: cli.version,
  description: cli.description,
  license: "MIT",
  type: "module",
  homepage: "https://ponzu.design",
  repository: { type: "git", url: "git+https://github.com/north-brook/ponzu.git" },
  keywords: ["design", "canvas", "mcp", "agent", "html", "css"],
  bin: { ponzu: "dist/index.js" },
  // The CLI loads the renderer by this name: here the bundle beside it, in a
  // checkout @ponzu/render (apps/cli/package.json).
  imports: { "#chromium": "./dist/chromium.js" },
  files: ["dist", "studio"],
  dependencies: { "playwright-core": render.dependencies["playwright-core"] },
};
await mkdir(out, { recursive: true });
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`ponzu ${cli.version} in ${out}`);

/*
 * `bun run package:preview`: Ponzu Preview, the release under its own name (src/packaging.ts),
 * for running the cloud app on a Mac that still uses Ponzu 1.x. Builds the main process as the
 * preview, the studio, then the app into out/preview/<platform>-unpacked (out/preview/mac-arm64
 * on an Apple silicon Mac). On a Mac it also zips the app with ditto, which keeps its signature
 * and extended attributes, into out/preview/Ponzu-Preview-<version>-<arch>.zip.
 *
 * Unsigned without a Developer ID (the fuses then sign it ad hoc) and never notarized without the
 * App Store Connect key, as a release built here would be. docs: apps/desktop/README.md.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json";
import { type BuildConfig, PREVIEW, previewBuild } from "../src/packaging.ts";

const root = join(import.meta.dir, "..");

function run(command: string, args: string[], env: Record<string, string> = {}, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}

run("bun", ["scripts/build.ts"], { PONZU_VARIANT: "preview" });
run("bun", ["run", "--filter", "@ponzu/studio", "build"]);

const config = join(root, "out", "preview.electron-builder.json");
mkdirSync(join(root, "out"), { recursive: true });
writeFileSync(
  config,
  `${JSON.stringify(previewBuild(manifest.build as unknown as BuildConfig), null, 2)}\n`,
);
run("bunx", ["electron-builder", "--dir", "--publish", "never", "--config", config]);

if (process.platform === "darwin") {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const folder = join(root, PREVIEW.output, arch === "arm64" ? "mac-arm64" : "mac");
  const zip = join(root, PREVIEW.output, `Ponzu-Preview-${manifest.version}-${arch}.zip`);
  rmSync(zip, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", `${PREVIEW.productName}.app`, zip], {}, folder);
  console.log(`\n${join(folder, `${PREVIEW.productName}.app`)}\n${zip}`);
}

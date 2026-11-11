/*
 * The studio's own vite config, plus a stamp of what the build read (scripts/prebuilt.ts): every
 * module in its graph, from the workspace and node_modules; every file under src/ and public/,
 * which Tailwind scans (src/app/app.css, src/cloud/styles/cloud.css) or vite copies; and the
 * HTML entries and configs. Only scripts/prebuild-tests.ts builds with it.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConfigEnv, mergeConfig, type Plugin, type UserConfig } from "vite";
import studio from "../vite.config.ts";
import { buildEnv, describe, filesUnder, type Kind, STAMP, type Stamp } from "./prebuilt.ts";

// Vite loads this under Node, so no Bun APIs here or in what it imports.
const STUDIO = fileURLToPath(new URL("..", import.meta.url));

function stamp(kind: Kind): Plugin {
  return {
    name: "ponzu-prebuilt-stamp",
    apply: "build",
    generateBundle() {
      const scanned = [join(STUDIO, "src"), join(STUDIO, "public")];
      const read = [
        ...this.getModuleIds(),
        ...scanned.flatMap(filesUnder),
        ...["index.html", "gallery.html", "vite.config.ts", "package.json", "tsconfig.json"].map(
          (file) => join(STUDIO, file),
        ),
      ];
      const sources: Stamp["sources"] = {};
      for (const id of new Set(read)) {
        // Virtual modules and query-suffixed ids aren't files.
        const file = id.split("?")[0]!;
        if (file.startsWith("\0") || !file.startsWith("/")) continue;
        const now = describe(file);
        if (now) sources[file] = now;
      }
      const body: Stamp = { kind, env: buildEnv(), scanned, sources };
      this.emitFile({ type: "asset", fileName: STAMP, source: JSON.stringify(body) });
    },
  };
}

export default async (env: ConfigEnv): Promise<UserConfig> => {
  const base = typeof studio === "function" ? await studio(env) : await studio;
  const kind = process.env.PONZU_PREBUILT_KIND as Kind | undefined;
  if (kind !== env.mode) throw new Error("PONZU_PREBUILT_KIND must be the build's --mode.");
  return mergeConfig(base, { plugins: [stamp(kind)] });
};

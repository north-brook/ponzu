/*
 * Builds the main process and the preload into dist/. `PONZU_TEST_BUILD=1` makes a test build
 * (src/config.ts): the real app, which also honours PONZU_SESSION_FILE and a remote debugging
 * port, for spare and CI to drive it signed in. The release workflow never sets it.
 * `PONZU_VARIANT=dev` builds Ponzu Dev's (scripts/package-dev.ts sets it).
 *
 * `PONZU_POSTHOG_KEY`, `PONZU_POSTHOG_HOST` and `PONZU_POSTHOG_REPLAY` name the PostHog project
 * the build reports to and what replay may show (docs/analytics.md); without a key it reports
 * nothing. With `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` it also writes source maps,
 * for scripts/sourcemaps.ts to upload and delete before packaging.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { uploadsSourceMaps } from "./sourcemaps.ts";

const root = join(import.meta.dir, "..");
const testBuild = process.env.PONZU_TEST_BUILD === "1";
const variant = process.env.PONZU_VARIANT || "release";
if (variant !== "release" && variant !== "dev") {
  console.error(`PONZU_VARIANT is "release" or "dev", not "${variant}".`);
  process.exit(1);
}
const posthog = {
  key: process.env.PONZU_POSTHOG_KEY ?? "",
  host: process.env.PONZU_POSTHOG_HOST ?? "",
  replay: process.env.PONZU_POSTHOG_REPLAY ?? "",
};
rmSync(join(root, "dist"), { recursive: true, force: true });

for (const entry of ["main", "preload"]) {
  const built = await Bun.build({
    entrypoints: [join(root, "src", `${entry}.ts`)],
    outdir: join(root, "dist"),
    naming: `${entry}.cjs`,
    target: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: uploadsSourceMaps(process.env) ? "linked" : "none",
    define: {
      PONZU_TEST_BUILD: JSON.stringify(testBuild),
      PONZU_VARIANT: JSON.stringify(variant),
      PONZU_POSTHOG: JSON.stringify(posthog),
    },
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
}
if (testBuild) console.log("A test build: it takes PONZU_SESSION_FILE and remote debugging.");
if (variant === "dev") console.log("Ponzu Dev: its own name, data, keychain and links.");
console.log(
  posthog.key
    ? "Reports usage to the PostHog project PONZU_POSTHOG_KEY names."
    : "Reports no usage.",
);

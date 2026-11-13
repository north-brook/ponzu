/*
 * Builds the main process, the window's preload and the picture window's (picture-preload.ts)
 * into dist/. `PONZU_TEST_BUILD=1` makes a test build (src/config.ts): the real app, which also
 * honours PONZU_SESSION_FILE, PONZU_ENVIRONMENT_OVERRIDE
 * and a remote debugging port, for spare and CI to drive it signed in. The release workflow
 * never sets it. `PONZU_VARIANT=dev` builds Ponzu Dev's (scripts/package-dev.ts sets it).
 *
 * Where the app talks to comes from infra/environments.json (docs/production.md): a release
 * build takes the environment its `release` names, Ponzu Dev takes dev's, and a field of it that
 * is still null fails the build. The environment and the commit (the checkout's HEAD, or
 * GITHUB_SHA where there is no git) are baked in, for the About panel and every analytics event.
 *
 * `PONZU_POSTHOG_KEY`, `PONZU_POSTHOG_HOST` and `PONZU_POSTHOG_REPLAY` name the PostHog project
 * the build reports to and what replay may show (docs/analytics.md); without a key it reports
 * nothing. With `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` it also writes source maps,
 * for scripts/sourcemaps.ts to upload and delete before packaging.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironments } from "../../../scripts/prod/desired.ts";
import { type BuildEnvironment, bakeEnvironment } from "../src/config.ts";
import { uploadsSourceMaps } from "./sourcemaps.ts";

const root = join(import.meta.dir, "..");
const testBuild = process.env.PONZU_TEST_BUILD === "1";
const variant = process.env.PONZU_VARIANT || "release";
if (variant !== "release" && variant !== "dev") {
  console.error(`PONZU_VARIANT is "release" or "dev", not "${variant}".`);
  process.exit(1);
}
let environment: BuildEnvironment;
try {
  environment = bakeEnvironment(loadEnvironments(), variant);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const commit = buildCommit();
const posthog = {
  key: process.env.PONZU_POSTHOG_KEY ?? "",
  host: process.env.PONZU_POSTHOG_HOST ?? "",
  replay: process.env.PONZU_POSTHOG_REPLAY ?? "",
};
rmSync(join(root, "dist"), { recursive: true, force: true });

for (const entry of ["main", "preload", "picture-preload"]) {
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
      PONZU_ENVIRONMENT: JSON.stringify(environment),
      PONZU_COMMIT: JSON.stringify(commit),
    },
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
}
if (testBuild) {
  console.log(
    "A test build: it takes PONZU_SESSION_FILE, PONZU_ENVIRONMENT_OVERRIDE and remote debugging.",
  );
}
if (variant === "dev") console.log("Ponzu Dev: its own name, data, keychain and links.");
console.log(`Talks to ${environment.name} (${environment.apiUrl}), from ${commit.slice(0, 7)}.`);
console.log(
  posthog.key
    ? "Reports usage to the PostHog project PONZU_POSTHOG_KEY names."
    : "Reports no usage.",
);

/**
 * The commit this is built from: the checkout's HEAD, else CI's GITHUB_SHA, else `unknown`.
 * HEAD first, because release.yml checks out the tag it builds, and a push's GITHUB_SHA is
 * main's head, not the tag's commit.
 */
function buildCommit(): string {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const head = git.status === 0 ? git.stdout.trim() : "";
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const fromCi = process.env.GITHUB_SHA?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{40}$/.test(fromCi) ? fromCi : "unknown";
}

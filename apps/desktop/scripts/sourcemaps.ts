/*
 * Source maps for PostHog's error tracking (docs/analytics.md, "Errors"), run by electron-builder
 * before it packs the app (scripts/before-pack.cjs): the main process's and preload's build in
 * dist/, and the studio's in ../studio/dist.
 *
 * With `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` (the names apps/mobile uses), the
 * builds wrote maps: PostHog's CLI injects a chunk id into each file (`sourcemap inject`), then
 * uploads the maps and deletes them (`sourcemap upload --delete-after`), so a stack trace from
 * the field reads as source and no map ships. Without them nothing is uploaded, and any map a
 * build left is deleted all the same: the app never carries one.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Whether this build uploads source maps, and so should write them. */
export function uploadsSourceMaps(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.POSTHOG_CLI_API_KEY?.trim() && env.POSTHOG_CLI_PROJECT_ID?.trim());
}

export type Run = (args: string[]) => { ok: boolean; output: string };

/** What is done to each folder: `upload`, or `strip` (maps deleted, nothing sent). */
export function prepareSourceMaps(
  dirs: string[],
  env: NodeJS.ProcessEnv,
  release: { name: string; version: string },
  run: Run,
): "upload" | "strip" {
  const upload = uploadsSourceMaps(env);
  for (const dir of dirs) {
    if (!hasMaps(dir)) continue;
    if (upload) {
      const releaseArgs = ["--release-name", release.name, "--release-version", release.version];
      for (const step of [
        ["sourcemap", "inject", "--directory", dir, ...releaseArgs],
        ["sourcemap", "upload", "--directory", dir, ...releaseArgs, "--delete-after"],
      ]) {
        // PostHog being away costs the release its readable stack traces, never the release.
        const result = run(step);
        if (!result.ok) {
          console.warn(`posthog-cli ${step.slice(0, 2).join(" ")} failed:\n${result.output}`);
          break;
        }
      }
    }
    // Whatever the CLI left, and every map when it didn't run.
    stripMaps(dir);
  }
  return upload ? "upload" : "strip";
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function hasMaps(dir: string): boolean {
  return files(dir).some((f) => f.endsWith(".map"));
}

/** Deletes every .map under `dir` and the comment that points at one. */
export function stripMaps(dir: string): void {
  for (const file of files(dir)) {
    if (file.endsWith(".map")) rmSync(file, { force: true });
    else if (/\.(c|m)?js$/.test(file)) {
      const text = readFileSync(file, "utf8");
      const stripped = text.replace(/\n?\/\/# sourceMappingURL=\S+\.map\s*$/, "\n");
      if (stripped !== text) writeFileSync(file, stripped);
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const cli = join(root, "node_modules", ".bin", "posthog-cli");
  const done = prepareSourceMaps(
    [join(root, "dist"), join(root, "..", "studio", "dist")],
    process.env,
    { name: "ponzu-desktop", version: manifest.version },
    (args) => {
      const result = spawnSync(cli, args, { encoding: "utf8", stdio: "pipe" });
      return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
  );
  console.log(
    done === "upload"
      ? "Source maps uploaded to PostHog and removed from the app."
      : "No PostHog CLI credentials: source maps left out of the app, none uploaded.",
  );
}

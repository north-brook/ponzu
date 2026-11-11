/*
 * The runner bundle the API serves (`GET /v1/runner/bundle`) and names at every start
 * (`PONZU_RUNNER_BUNDLE`, its sha256). The image's `ponzu-start` fetches it when that hash is not
 * on the disk yet, checks the hash, checks `manifest.json` against the image's own versions
 * (`bundle-fits`), and runs `supervise.js` from it. scripts/build.ts makes it.
 *
 * `@ponzu/runner/bundle`: the API reaches it only through `deps.runnerBundle`, so its tests
 * inject a fake one and nothing here needs a build to typecheck or test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RunnerBundle {
  /** sha256 (hex) of the tgz's bytes. */
  sha256: string;
  /**
   * What the bundle needs of the image, from the runner's own dependencies: `claude` is the
   * Agent SDK's `claudeCodeVersion`, `playwrightCore` the playwright-core the renderer resolved.
   * `bundle-fits` checks them against /opt/ponzu/image.json.
   */
  requires: { claude: string; playwrightCore: string };
  /** base64 of the tgz: runner.js, supervise.js, git-credential.js and manifest.json. */
  tgz: string;
}

/** What `manifest.json` in the tgz says. */
export interface RunnerManifest {
  name: "ponzu-runner";
  /** The runner's package version. */
  version: string;
  requires: RunnerBundle["requires"];
  /** The files beside it. */
  files: string[];
}

/** Set by apps/api/scripts/build.ts (`Bun.build`'s `define`): the bundle, inlined. */
declare const __PONZU_RUNNER_BUNDLE__: RunnerBundle | undefined;

let read: RunnerBundle | null = null;

/**
 * The bundle this build serves: the define when the API was built by its scripts/build.ts,
 * otherwise `dist/bundle.json` beside the runner's source, which `bun run build` in
 * apps/runner writes.
 */
export function runnerBundle(): RunnerBundle {
  if (typeof __PONZU_RUNNER_BUNDLE__ !== "undefined") return __PONZU_RUNNER_BUNDLE__;
  if (read) return read;
  // Not import.meta.dir: the API runs on Node.
  const file = fileURLToPath(new URL("../dist/bundle.json", import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `No runner bundle at ${file}: build the runner first (bun run --filter @ponzu/runner build). ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
  read = checked(parsed, file);
  return read;
}

function checked(value: unknown, file: string): RunnerBundle {
  const b = value as Partial<RunnerBundle> | null;
  if (
    !b ||
    typeof b.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(b.sha256) ||
    typeof b.tgz !== "string" ||
    typeof b.requires?.claude !== "string" ||
    typeof b.requires?.playwrightCore !== "string"
  ) {
    throw new Error(`${file} is not a runner bundle: build the runner again.`);
  }
  return { sha256: b.sha256, requires: { ...b.requires }, tgz: b.tgz } as RunnerBundle;
}

#!/usr/bin/env bun
/**
 * Builds the cloud API for Vercel (apps/api/vercel.json's `buildCommand` runs `bun run build`):
 *
 *   1. the runner bundle (apps/runner/scripts/build.ts) into a temporary directory;
 *   2. the API with Bun.build into dist/, with that bundle inlined as `__PONZU_RUNNER_BUNDLE__`
 *      (`@ponzu/runner/bundle`), which `GET /v1/runner/bundle` serves and every start names.
 *
 * Through Bun's API and not its command line: the define is about a megabyte, and one argument
 * may be at most 128 KB.
 *
 *   bun scripts/build.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunnerBundle } from "@ponzu/runner/bundle";

const api = resolve(import.meta.dir, "..");
const runnerBuild = resolve(api, "../runner/scripts/build.ts");
const temp = mkdtempSync(join(tmpdir(), "ponzu-runner-bundle-"));

try {
  const built = spawnSync(process.execPath, [runnerBuild, "--outdir", temp], {
    stdio: "inherit",
  });
  if (built.status !== 0) throw new Error(`The runner build exited ${built.status}.`);
  const bundle = JSON.parse(readFileSync(join(temp, "bundle.json"), "utf8")) as RunnerBundle;
  if (!/^[0-9a-f]{64}$/.test(bundle.sha256)) throw new Error("The runner build wrote no bundle.");

  rmSync(join(api, "dist"), { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(api, "src/index.ts")],
    outdir: join(api, "dist"),
    target: "node",
    format: "esm",
    external: ["hono", "hono/*"],
    sourcemap: "linked",
    define: {
      __PONZU_RUNNER_BUNDLE__: JSON.stringify(bundle),
      // React (inlined for @ponzu/email's templates) picks its production or development build
      // from NODE_ENV when it loads. Fixed here so the function never depends on whether the
      // environment sets it; scripts/ci/api-bundle.ts checks no development build is inside.
      "process.env.NODE_ENV": '"production"',
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("The API build failed.");
  }
  console.log(
    `Built the API with runner bundle ${bundle.sha256} (${Buffer.from(bundle.tgz, "base64").byteLength} bytes).`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

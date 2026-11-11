#!/usr/bin/env bun
/**
 * Builds the sandbox image with Docker and pushes it to Vercel Container Registry, tagged by the
 * hash of its inputs, and prints the digest a sandbox is created from:
 *
 *   vercel vcr login docker --project <api project> --scope <team>     (12 hours)
 *   bun apps/runner/image/vcr.ts <team-slug>/<project>/<repository>
 *
 * e.g. `northbrook/ponzu-api/ponzu-runner`. The build is linux/amd64 (what Sandbox runs; on an
 * Apple Silicon Mac Docker emulates it) and pushed with zstd layers, which VCR prepares faster.
 * The image is made only from this checkout: the runner's dist/, provision.sh, the font
 * manifest and the pins. No secret is ever part of it: the build has no environment.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputsHash, RUNNER, readPins, recipeInputs, stage } from "./recipe.ts";

const repository = process.argv[2];
if (!repository || repository.split("/").length !== 3)
  throw new Error("say <team-slug>/<project>/<repository>");

const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${r.status}`);
};

const t0 = performance.now();
run("bun", ["scripts/build.ts", "--smoke"], RUNNER);
const pins = readPins();
const dockerfile = join(import.meta.dir, "Dockerfile");
const inputs = recipeInputs(pins, await Bun.file(dockerfile).text());
const hash = inputsHash(inputs);
const ref = `vcr.vercel.com/${repository}:${hash.slice(0, 12)}`;
const dir = mkdtempSync(join(tmpdir(), "ponzu-image-"));
try {
  stage(dir, inputs, pins, hash);
  copyFileSync(dockerfile, join(dir, "Dockerfile"));
  const built = performance.now();
  run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--provenance=false",
    "--output",
    `type=image,name=${ref},push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true`,
    dir,
  ]);
  const pushed = performance.now();
  const inspect = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
    {
      encoding: "utf8",
    },
  );
  const manifest = JSON.parse(inspect.stdout || "{}") as { digest?: string };
  console.log(
    JSON.stringify({
      ref,
      digest: manifest.digest ?? null,
      image: manifest.digest ? `${repository}@${manifest.digest}` : null,
      inputs: hash,
      distSeconds: Math.round(built - t0) / 1000,
      buildAndPushSeconds: Math.round(pushed - built) / 1000,
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

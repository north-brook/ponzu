#!/usr/bin/env bun
/**
 * Builds the sandbox image, pushes it to the ponzu-api project's Vercel Container Registry as
 * ponzu-runner, waits for VCR to have it Ready, checks it in a sandbox (checks.ts) and records
 * it in current.json, which the API ships with:
 *
 *   vercel vcr login docker --project <ponzu-api> --scope <team>     (12 hours; CI: vcr-action)
 *   bun apps/runner/image/build.ts [--force]
 *
 * Needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (ponzu-api's), for the registry reads
 * and the checks' sandbox. VCR_REPOSITORY is the push target, <team-slug>/<project>/ponzu-runner
 * (northbrook/ponzu-api/ponzu-runner unless set).
 *
 * The tag is the first 12 of the inputs' hash (image.ts): a tag VCR already has is not built
 * again, and an image current.json already records as checked is left as it is. --force builds
 * and checks even so. The build is linux/amd64 (what Sandbox runs; on an Apple Silicon Mac
 * Docker emulates it) with zstd layers, which VCR prepares faster. No secret is ever part of it:
 * the build has no environment, and its context is only image.ts's inputs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImageChecks } from "./checks.ts";
import {
  baseImage,
  type CurrentImage,
  imageInputs,
  inputsHash,
  pins,
  REPOSITORY,
  readCurrent,
  stage,
  tagOf,
  writeCurrent,
} from "./image.ts";
import { credentials, filesWithSecrets, removeOnSignal, secretValues, until } from "./live.ts";

const READY_MS = 15 * 60_000;

interface VcrImage {
  id: string;
  manifestDigest: `sha256:${string}`;
  status: string;
  sizeInBytes: number;
  createdAt: string;
  tags: string[];
}

const force = process.argv.includes("--force");
const creds = credentials();
const repository = process.env.VCR_REPOSITORY ?? `northbrook/ponzu-api/${REPOSITORY}`;
if (repository.split("/").length !== 3 || !repository.endsWith(`/${REPOSITORY}`))
  throw new Error(`VCR_REPOSITORY is <team-slug>/<project>/${REPOSITORY}, not ${repository}`);
removeOnSignal();

const t0 = performance.now();
const inputs = imageInputs();
const hash = inputsHash(inputs);
const tag = tagOf(hash);
const ref = `vcr.vercel.com/${repository}:${tag}`;
console.log(`inputs ${hash}\ntag ${tag}`);

let image = (await vcrImages()).find((i) => i.tags.includes(tag));
const known = safeCurrent();
if (image && !force && known?.inputs === hash && known.digest === image.manifestDigest) {
  console.log(`already built and checked at ${known.checkedAt}: ${known.image}`);
  process.exit(0);
}

if (!image || force) {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-image-"));
  try {
    stage(dir, inputs);
    // What is staged is all that reaches the image from here: none of this machine's secrets
    // may be in it, whatever shape they have.
    const leaks = filesWithSecrets(dir, secretValues(process.env));
    if (leaks.length) throw new Error(`secrets in the image's inputs:\n${leaks.join("\n")}`);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`built and pushed in ${since(t0)} s`);
  const inspect = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
    { encoding: "utf8" },
  );
  const digest = (JSON.parse(inspect.stdout || "{}") as { digest?: string }).digest;
  if (!digest?.startsWith("sha256:")) throw new Error(`no digest for ${ref}: ${inspect.stderr}`);
  const pushed = performance.now();
  image = await until(
    `${ref} to be Ready in VCR`,
    async () => {
      const found = (await vcrImages()).find((i) => i.manifestDigest === digest);
      if (found?.status === "error") throw new Error(`VCR could not prepare ${digest}`);
      return found?.status === "ready" ? found : null;
    },
    READY_MS,
    5_000,
  );
  console.log(`Ready in VCR ${since(pushed)} s after the push`);
} else {
  console.log(`VCR already has ${tag} (${image.manifestDigest}); checking it`);
  if (image.status !== "ready") throw new Error(`${tag} is ${image.status} in VCR`);
}

const reference = `${REPOSITORY}@${image.manifestDigest}`;
const checked = performance.now();
await runImageChecks(reference, { pins });
console.log(`checks passed in ${since(checked)} s`);

const current: CurrentImage = {
  image: reference,
  digest: image.manifestDigest,
  repository,
  tag,
  inputs: hash,
  base: baseImage(),
  builtAt: image.createdAt,
  checkedAt: new Date().toISOString(),
  sizeBytes: image.sizeInBytes,
  pins,
};
writeCurrent(current);
console.log(`\nrecorded ${reference} in current.json (${since(t0)} s in all)`);

/** The repository's images, through the Vercel CLI (VERCEL_TOKEN from the environment). */
async function vcrImages(): Promise<VcrImage[]> {
  const r = spawnSync(
    "vercel",
    [
      "vcr",
      "image",
      "ls",
      REPOSITORY,
      "--project",
      creds.projectId,
      "--scope",
      creds.teamId,
      "--format",
      "json",
      "--limit",
      "100",
      "--non-interactive",
    ],
    { encoding: "utf8", env: { ...process.env, VERCEL_TOKEN: creds.token } },
  );
  if (r.status !== 0) {
    // A repository nothing was pushed to yet has no images.
    if (/not.?found/i.test(r.stderr)) return [];
    throw new Error(`vercel vcr image ls exited ${r.status}: ${r.stderr.slice(-800)}`);
  }
  return (JSON.parse(r.stdout) as { images: VcrImage[] }).images;
}

function safeCurrent(): CurrentImage | null {
  try {
    return readCurrent();
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${r.status}`);
}

function since(t: number): number {
  return Math.round((performance.now() - t) / 100) / 10;
}

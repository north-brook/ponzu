/*
 * What the sandbox image is made from, read from this checkout: the pins (pins.json, the one
 * place a version or hash is written), the files the Docker build is given, and the hash of
 * them that names the image's tag. The same inputs make the same tag, so a build of a tag VCR
 * already has is skipped.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pinsJson from "./pins.json" with { type: "json" };

export const IMAGE_DIR = import.meta.dir;
export const RUNNER = join(IMAGE_DIR, "..");
export const ROOT = join(RUNNER, "..", "..");
export const CURRENT = join(IMAGE_DIR, "current.json");
const FONTS = join(ROOT, "packages", "render", "sandbox-fonts.json");

/** The VCR repository, in the ponzu-api project (a repository belongs to one project). */
export const REPOSITORY = "ponzu-runner";

export interface Pins {
  bunVersion: string;
  bunSha256: string;
  claudeVersion: string;
  /** The linux-x64 binary's, from the Agent SDK's own manifest. */
  claudeSha256: string;
  /** Claude Code's native binary for linux-x64 at exactly that version. */
  claudeUrl: string;
  playwrightCoreVersion: string;
  /** The Chrome Headless Shell that playwright-core version downloads, its build and zip. */
  headlessShellVersion: string;
  headlessShellRevision: string;
  headlessShellUrl: string;
  headlessShellSha256: string;
}

export const pins: Pins = pinsJson;

/** What current.json records (`@ponzu/runner/image/current.json`): the image the API runs. */
export interface CurrentImage {
  /** "ponzu-runner@sha256:<digest>": what Sandbox.create takes. */
  image: string;
  digest: `sha256:${string}`;
  /** As Sandbox.image reports it: "<team>/<project>/ponzu-runner". */
  repository: string;
  /** inputs.slice(0, 12). */
  tag: string;
  inputs: string;
  /** The Dockerfile's FROM. */
  base: string;
  builtAt: string;
  /** When checks.ts last passed in a sandbox made from it. */
  checkedAt: string;
  sizeBytes: number;
  pins: Pins;
}

export interface Input {
  /** Where it goes in the build's context. */
  path: string;
  bytes: Uint8Array;
}

/** Everything the image is made from, in the build context's layout. */
export function imageInputs(): Input[] {
  const read = (path: string, from: string): Input => ({ path, bytes: readFileSync(from) });
  return [
    read("Dockerfile", join(IMAGE_DIR, "Dockerfile")),
    read("provision.sh", join(IMAGE_DIR, "provision.sh")),
    read("pins.json", join(IMAGE_DIR, "pins.json")),
    read("sandbox-fonts.json", FONTS),
    ...readdirSync(join(IMAGE_DIR, "libexec"))
      .sort()
      .map((name) => read(`libexec/${name}`, join(IMAGE_DIR, "libexec", name))),
  ];
}

/** The same inputs always hash the same, whatever order they were read in. */
export function inputsHash(inputs: Input[]): string {
  const hash = createHash("sha256");
  for (const input of [...inputs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${input.path}\0${input.bytes.length}\0`);
    hash.update(input.bytes);
  }
  return hash.digest("hex");
}

/** The tag an image of these inputs is pushed under. */
export function tagOf(inputs: string): string {
  return inputs.slice(0, 12);
}

/** Writes the build's context. */
export function stage(dir: string, inputs: Input[]): void {
  for (const input of inputs) {
    mkdirSync(dirname(join(dir, input.path)), { recursive: true });
    writeFileSync(join(dir, input.path), input.bytes);
  }
}

/** The Dockerfile's base, by digest. */
export function baseImage(dockerfile = readFileSync(join(IMAGE_DIR, "Dockerfile"), "utf8")) {
  const from = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1];
  if (!from?.includes("@sha256:")) throw new Error("the Dockerfile's FROM is not pinned by digest");
  return from;
}

const packageJson = (name: string, from: string) =>
  JSON.parse(readFileSync(Bun.resolveSync(`${name}/package.json`, from), "utf8"));

/**
 * What the runner bundle requires of the image, derived as apps/runner/scripts/build.ts does:
 * the Agent SDK's `claudeCodeVersion` and the renderer's playwright-core.
 */
export function runnerRequires(): { claude: string; playwrightCore: string } {
  return {
    claude: packageJson("@anthropic-ai/claude-agent-sdk", RUNNER).claudeCodeVersion,
    playwrightCore: packageJson("playwright-core", join(ROOT, "packages", "render")).version,
  };
}

/**
 * What pins each pin, read from the checkout: Bun from the repo's `packageManager`, Claude
 * Code's binary hash from the Agent SDK's manifest, the headless shell from playwright-core's
 * browsers.json. image.test.ts holds pins.json to them.
 */
export function upstreamPins(): Partial<Pins> {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", RUNNER));
  const manifest = JSON.parse(readFileSync(join(sdk, "manifest.json"), "utf8"));
  const core = dirname(
    Bun.resolveSync("playwright-core/package.json", join(ROOT, "packages", "render")),
  );
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")).browsers as {
    name: string;
    revision: string;
    browserVersion: string;
  }[];
  const shell = browsers.find((b) => b.name === "chromium-headless-shell");
  return {
    bunVersion: String(root.packageManager).replace(/^bun@/, ""),
    claudeVersion: manifest.version,
    claudeSha256: manifest.platforms["linux-x64"].checksum,
    claudeUrl: `https://downloads.claude.ai/claude-code-releases/${manifest.version}/linux-x64/claude`,
    playwrightCoreVersion: JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version,
    headlessShellVersion: shell?.browserVersion,
    headlessShellRevision: shell?.revision,
    headlessShellUrl: shell
      ? `https://cdn.playwright.dev/builds/cft/${shell.browserVersion}/linux64/chrome-headless-shell-linux64.zip`
      : undefined,
  };
}

export function readCurrent(): CurrentImage {
  return JSON.parse(readFileSync(CURRENT, "utf8")) as CurrentImage;
}

export function writeCurrent(current: CurrentImage): void {
  writeFileSync(CURRENT, `${JSON.stringify(current, null, 2)}\n`);
}

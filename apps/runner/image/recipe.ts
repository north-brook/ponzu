/*
 * What goes into the sandbox image, read from this checkout: the versions it pins, the folder
 * provision.sh runs from, and the name the image is saved under. The name is a hash of all of
 * it, of the checks it passed and of boat's base it was made on, so the same inputs make the
 * same name and a bake of an image that exists is skipped.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import bunPin from "./bun.json" with { type: "json" };
import chromiumPin from "./chromium.json" with { type: "json" };

export const RUNNER = join(import.meta.dir, "..");
const ROOT = join(RUNNER, "..", "..");
export const DIST = join(RUNNER, "dist");
const RECIPE = join(import.meta.dir, "provision.sh");
const FONTS = join(ROOT, "packages", "render", "sandbox-fonts.json");

/** Saved snapshots this recipe made start with it; anything else on the account is left alone. */
export const SNAPSHOT_PREFIX = "ponzu-runner-";

export interface Pins {
  bunVersion: string;
  bunSha256: string;
  claudeVersion: string;
  /** The linux-x64 binary's, from the Agent SDK's own manifest. */
  claudeSha256: string;
  /** Where that binary is fetched from (`claudeBinaryUrl`). */
  claudeUrl: string;
  playwrightCoreVersion: string;
  /** The Chrome Headless Shell that playwright-core version downloads. */
  headlessShellVersion: string;
  /** Its build for linux-x64 and the zip's hash, from chromium.json. */
  headlessShellRevision: string;
  headlessShellUrl: string;
  headlessShellSha256: string;
}

/**
 * The versions the image must have, each from what pins it: Bun from the repo's
 * `packageManager` (with the hash in bun.json), Claude Code from the runner's Agent SDK, Chromium
 * from the playwright-core the renderer resolved, which the runner's build puts in dist/.
 */
export function readPins(): Pins {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const bun = String(root.packageManager).replace(/^bun@/, "");
  if (bun !== bunPin.version)
    throw new Error(
      `package.json pins Bun ${bun} but image/bun.json has ${bunPin.version}: put ${bun}'s bun-linux-x64.zip hash there.`,
    );
  const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", RUNNER));
  const claude = JSON.parse(readFileSync(join(sdk, "manifest.json"), "utf8"));
  const core = dirname(
    Bun.resolveSync("playwright-core/package.json", join(ROOT, "packages/render")),
  );
  const playwright = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version as string;
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")).browsers as {
    name: string;
    revision: string;
    browserVersion: string;
  }[];
  const shell = browsers.find((b) => b.name === "chromium-headless-shell");
  if (!shell) throw new Error("playwright-core names no chromium-headless-shell");
  if (
    shell.browserVersion !== chromiumPin.browserVersion ||
    shell.revision !== chromiumPin.revision
  )
    throw new Error(
      `playwright-core ${playwright} pins Chrome Headless Shell ${shell.browserVersion} (build ${shell.revision}) but image/chromium.json has ${chromiumPin.browserVersion}: put its linux64 zip's address and hash there.`,
    );
  return {
    bunVersion: bunPin.version,
    bunSha256: bunPin.linuxX64Sha256,
    claudeVersion: claude.version,
    claudeSha256: claude.platforms["linux-x64"].checksum,
    claudeUrl: claudeBinaryUrl(claude.version),
    playwrightCoreVersion: playwright,
    headlessShellVersion: shell.browserVersion,
    headlessShellRevision: chromiumPin.revision,
    headlessShellUrl: chromiumPin.url,
    headlessShellSha256: chromiumPin.sha256,
  };
}

/**
 * Claude Code's native binary for linux-x64 at exactly `version`: the file its own native
 * installer fetches for a pinned version, the binary alone, so nothing runs to install it (npm
 * 11 no longer runs a package's install scripts, which is how its npm package puts the binary
 * in place). provision.sh checks it against the hash in the Agent SDK's manifest.
 */
export function claudeBinaryUrl(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a Claude Code version: ${version}`);
  return `https://downloads.claude.ai/claude-code-releases/${version}/linux-x64/claude`;
}

/** The file provision.sh sources. */
export function pinsEnv(pins: Pins, inputs: string): string {
  return [
    `BUN_VERSION=${pins.bunVersion}`,
    `BUN_SHA256=${pins.bunSha256}`,
    `CLAUDE_VERSION=${pins.claudeVersion}`,
    `CLAUDE_SHA256=${pins.claudeSha256}`,
    `CLAUDE_URL=${pins.claudeUrl}`,
    `PLAYWRIGHT_CORE_VERSION=${pins.playwrightCoreVersion}`,
    `CHROMIUM_REVISION=${pins.headlessShellRevision}`,
    `CHROMIUM_URL=${pins.headlessShellUrl}`,
    `CHROMIUM_SHA256=${pins.headlessShellSha256}`,
    `INPUTS_HASH=${inputs}`,
    "",
  ].join("\n");
}

export interface Input {
  /** Where it goes in the folder provision.sh runs from. */
  path: string;
  bytes: Uint8Array;
  /** Hashed into the name but not sent: what the image was checked with, and against. */
  hashedOnly?: true;
}

/** The checks an image must pass, by where they live: tightening one makes a new image. */
const CHECKS = [
  join(import.meta.dir, "checks.ts"),
  join(import.meta.dir, "trial.ts"),
  ...readdirSync(join(import.meta.dir, "sandbox"))
    .sort()
    .map((name) => join(import.meta.dir, "sandbox", name)),
  join(ROOT, "packages", "render", "src", "stand-ins.test.ts"),
];

/**
 * Everything the image is made from, in the folder's layout. Needs a built dist/. `base` is
 * what boat's base image held before provisioning (`BASE_FINGERPRINT`): the same recipe on
 * another base is another image.
 */
export function recipeInputs(pins: Pins, base: string, dist = DIST): Input[] {
  const files: Input[] = [
    { path: "provision.sh", bytes: readFileSync(RECIPE) },
    { path: "sandbox-fonts.json", bytes: readFileSync(FONTS) },
    { path: "pins.json", bytes: Buffer.from(JSON.stringify(pins)), hashedOnly: true },
    { path: "base.txt", bytes: Buffer.from(base), hashedOnly: true },
  ];
  for (const file of CHECKS)
    files.push({
      path: join("checks", relative(ROOT, file)),
      bytes: readFileSync(file),
      hashedOnly: true,
    });
  for (const file of walk(dist))
    files.push({ path: join("runner", relative(dist, file)), bytes: readFileSync(file) });
  return files;
}

/**
 * What boat's base image is, read in a fresh sandbox before the recipe runs: the system, every
 * package and its version, the fonts fallback can find, and the Claude Code and Bun it ships,
 * which the recipe replaces with its own whatever they are. boat names no version of its base,
 * so this is how a change to it is seen.
 */
export const BASE_FINGERPRINT = `set -e
cat /etc/os-release
uname -r
dpkg-query -W -f '\${Package}=\${Version}\\n' | sort
find /usr/share/fonts /usr/local/share/fonts -type f 2>/dev/null | sort
sha256sum "$(readlink -f /usr/local/bin/claude)" 2>/dev/null | cut -d' ' -f1 || true
/usr/local/bin/bun --version 2>/dev/null || true`;

/** The same inputs always hash the same, whatever order they were read in. */
export function inputsHash(inputs: Input[]): string {
  const hash = createHash("sha256");
  for (const input of [...inputs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${input.path}\0${input.bytes.length}\0`);
    hash.update(input.bytes);
  }
  return hash.digest("hex");
}

export function snapshotName(inputs: string): string {
  return `${SNAPSHOT_PREFIX}${inputs.slice(0, 12)}`;
}

/** Writes the folder provision.sh runs from: the inputs, and the pins as it reads them. */
export function stage(dir: string, inputs: Input[], pins: Pins, hash: string): void {
  for (const input of inputs) {
    if (input.hashedOnly) continue;
    mkdirSync(dirname(join(dir, input.path)), { recursive: true });
    writeFileSync(join(dir, input.path), input.bytes);
  }
  writeFileSync(join(dir, "pins.env"), pinsEnv(pins, hash));
}

/**
 * The snapshots to delete: this recipe's, but for the newest `keep` and the one the API runs.
 * Sorted oldest first.
 */
export function prunable<T extends { name: string; createdAt: number }>(
  snapshots: T[],
  opts: { keep: number; current: string | null },
): T[] {
  const ours = snapshots
    .filter((s) => s.name.startsWith(SNAPSHOT_PREFIX))
    .sort((a, b) => b.createdAt - a.createdAt);
  return ours
    .slice(opts.keep)
    .filter((s) => s.name !== opts.current)
    .reverse();
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

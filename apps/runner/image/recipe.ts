/*
 * What goes into the sandbox image, read from this checkout: the versions it pins, the folder
 * provision.sh runs from, and the name the image is saved under. The name is a hash of all of
 * it, so the same inputs make the same name and a bake of an image that exists is skipped.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import bunPin from "./bun.json" with { type: "json" };

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
  playwrightCoreVersion: string;
  /** The Chrome Headless Shell that playwright-core version downloads. */
  headlessShellVersion: string;
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
    browserVersion: string;
  }[];
  const shell = browsers.find((b) => b.name === "chromium-headless-shell");
  if (!shell) throw new Error("playwright-core names no chromium-headless-shell");
  return {
    bunVersion: bunPin.version,
    bunSha256: bunPin.linuxX64Sha256,
    claudeVersion: claude.version,
    claudeSha256: claude.platforms["linux-x64"].checksum,
    playwrightCoreVersion: playwright,
    headlessShellVersion: shell.browserVersion,
  };
}

/** The file provision.sh sources. */
export function pinsEnv(pins: Pins, inputs: string): string {
  return [
    `BUN_VERSION=${pins.bunVersion}`,
    `BUN_SHA256=${pins.bunSha256}`,
    `CLAUDE_VERSION=${pins.claudeVersion}`,
    `CLAUDE_SHA256=${pins.claudeSha256}`,
    `PLAYWRIGHT_CORE_VERSION=${pins.playwrightCoreVersion}`,
    `INPUTS_HASH=${inputs}`,
    "",
  ].join("\n");
}

export interface Input {
  /** Where it goes in the folder provision.sh runs from. */
  path: string;
  bytes: Uint8Array;
}

/** Everything the image is made from, in the folder's layout. Needs a built dist/. */
export function recipeInputs(pins: Pins): Input[] {
  const files: Input[] = [
    { path: "provision.sh", bytes: readFileSync(RECIPE) },
    { path: "sandbox-fonts.json", bytes: readFileSync(FONTS) },
    { path: "pins.json", bytes: Buffer.from(JSON.stringify(pins)) },
  ];
  for (const file of walk(DIST))
    files.push({ path: join("runner", relative(DIST, file)), bytes: readFileSync(file) });
  return files;
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

export function snapshotName(inputs: string): string {
  return `${SNAPSHOT_PREFIX}${inputs.slice(0, 12)}`;
}

/** Writes the folder provision.sh runs from: the inputs, and the pins as it reads them. */
export function stage(dir: string, inputs: Input[], pins: Pins, hash: string): void {
  for (const input of inputs) {
    if (input.path === "pins.json") continue;
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

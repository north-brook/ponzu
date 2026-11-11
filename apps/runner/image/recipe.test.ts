import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeBinaryUrl,
  type Input,
  inputsHash,
  pinsEnv,
  prunable,
  readPins,
  recipeInputs,
  SNAPSHOT_PREFIX,
  snapshotName,
} from "./recipe.ts";

test("every version comes from what pins it, and Bun's from the repo's packageManager", () => {
  const pins = readPins();
  const root = require("../../../package.json");
  expect(`bun@${pins.bunVersion}`).toBe(root.packageManager);
  // The Agent SDK is released with the Claude Code it speaks to: 0.3.x with 2.1.x.
  const sdk = require("../package.json").dependencies["@anthropic-ai/claude-agent-sdk"];
  expect(pins.claudeVersion.split(".").at(-1)).toBe(sdk.split(".").at(-1));
  for (const hash of [pins.bunSha256, pins.claudeSha256]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(pins.playwrightCoreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pins.headlessShellVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});

test("provision.sh gets the pins and the inputs' hash as shell variables", () => {
  const env = pinsEnv(readPins(), "abc");
  expect(env).toContain("BUN_VERSION=");
  expect(env).toContain("CLAUDE_SHA256=");
  expect(env).toContain("PLAYWRIGHT_CORE_VERSION=");
  expect(env).toEndWith("INPUTS_HASH=abc\n");
  // Nothing in it needs quoting.
  for (const line of env.trim().split("\n")) expect(line).toMatch(/^[A-Z_0-9]+=[A-Za-z0-9.:/_-]+$/);
});

test("Claude Code is the pinned version's native binary, fetched as a file and checked by hash", () => {
  const pins = readPins();
  expect(pins.claudeUrl).toBe(claudeBinaryUrl(pins.claudeVersion));
  expect(claudeBinaryUrl("2.1.322")).toBe(
    "https://downloads.claude.ai/claude-code-releases/2.1.322/linux-x64/claude",
  );
  // A version is all that goes into the address: no tag, range or path.
  for (const bad of ["latest", "stable", "^2.1.322", "2.1", "2.1.322/../x", ""])
    expect(() => claudeBinaryUrl(bad)).toThrow();
  expect(pinsEnv(pins, "abc")).toContain(`CLAUDE_URL=${pins.claudeUrl}\n`);
  // The recipe installs what it fetched only once the SDK's hash matches, and never through a
  // package manager, whose install scripts may or may not run.
  const recipe = readFileSync(join(import.meta.dir, "provision.sh"), "utf8");
  expect(recipe).toContain('curl -fsSL --retry 3 -o "$work/claude" "$CLAUDE_URL"');
  expect(recipe.indexOf('echo "$CLAUDE_SHA256  $work/claude" | sha256sum --check')).toBeLessThan(
    recipe.indexOf('install -D -m 0755 "$work/claude"'),
  );
  expect(recipe).not.toMatch(/\bnpm (install|i)\b/);
  // boat puts its own /usr/local/bin/claude back at every create: the agent runs ours by path.
  expect(recipe).not.toMatch(/ln [^\n]*\/usr\/local\/bin\/claude/);
  expect(recipe).toContain('as-agent %s "$@"\\n\' "$PONZU" "$CLAUDE"');
});

test("the headless shell is the build playwright-core pins, fetched from where its installer would", () => {
  const pins = readPins();
  expect(pins.headlessShellUrl).toBe(
    `https://cdn.playwright.dev/builds/cft/${pins.headlessShellVersion}/linux64/chrome-headless-shell-linux64.zip`,
  );
  expect(pins.headlessShellSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the fonts are pinned to the versions the checks passed with", () => {
  const fonts = require("../../../packages/render/sandbox-fonts.json");
  for (const pkg of fonts.apt) expect(pkg).toMatch(/^[a-z0-9.+-]+=[0-9][A-Za-z0-9.+:~-]*$/);
});

test("the name covers boat's base and the checks, which are hashed but not sent", () => {
  const pins = readPins();
  const dist = mkdtempSync(join(tmpdir(), "ponzu-dist-"));
  try {
    writeFileSync(join(dist, "runner.js"), "1");
    const inputs = recipeInputs(pins, "Ubuntu 24.04", dist);
    const hashedOnly = inputs.filter((i) => i.hashedOnly).map((i) => i.path);
    expect(hashedOnly).toContain("base.txt");
    expect(hashedOnly).toContain("checks/apps/runner/image/checks.ts");
    expect(hashedOnly).toContain("checks/packages/render/src/stand-ins.test.ts");
    expect(inputs.find((i) => i.path === "runner/runner.js")?.hashedOnly).toBeUndefined();
    expect(inputsHash(recipeInputs(pins, "Ubuntu 24.04.1", dist))).not.toBe(inputsHash(inputs));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

const file = (path: string, text: string): Input => ({ path, bytes: Buffer.from(text) });

test("the same inputs make the same name, in any order, and any change makes another", () => {
  const a = [file("provision.sh", "echo"), file("runner/runner.js", "1")];
  const hash = inputsHash(a);
  expect(inputsHash([...a].reverse())).toBe(hash);
  expect(inputsHash([file("provision.sh", "echo"), file("runner/runner.js", "2")])).not.toBe(hash);
  expect(inputsHash([file("provision.sh", "echo"), file("runner/other.js", "1")])).not.toBe(hash);
  // A byte moved from one file to the next is a change too.
  expect(inputsHash([file("a", "xy"), file("b", "z")])).not.toBe(
    inputsHash([file("a", "x"), file("b", "yz")]),
  );
  // boat takes lowercase letters, digits and dashes.
  expect(snapshotName(hash)).toMatch(/^ponzu-runner-[0-9a-f]{12}$/);
});

test("pruning keeps the newest few and the one the API runs, and leaves others' snapshots alone", () => {
  const at = (name: string, createdAt: number) => ({ name, createdAt });
  const snapshots = [
    at(`${SNAPSHOT_PREFIX}aaa`, 1),
    at(`${SNAPSHOT_PREFIX}bbb`, 2),
    at(`${SNAPSHOT_PREFIX}ccc`, 3),
    at(`${SNAPSHOT_PREFIX}ddd`, 4),
    at("repo-base-north-fern", 0),
  ];
  expect(prunable(snapshots, { keep: 2, current: null }).map((s) => s.name)).toEqual([
    `${SNAPSHOT_PREFIX}aaa`,
    `${SNAPSHOT_PREFIX}bbb`,
  ]);
  expect(
    prunable(snapshots, { keep: 2, current: `${SNAPSHOT_PREFIX}aaa` }).map((s) => s.name),
  ).toEqual([`${SNAPSHOT_PREFIX}bbb`]);
  expect(prunable(snapshots, { keep: 5, current: null })).toEqual([]);
});

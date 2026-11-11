import { expect, test } from "bun:test";
import {
  type Input,
  inputsHash,
  pinsEnv,
  prunable,
  readPins,
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
  for (const line of env.trim().split("\n")) expect(line).toMatch(/^[A-Z_0-9]+=[A-Za-z0-9.]+$/);
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

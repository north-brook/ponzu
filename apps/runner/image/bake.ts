#!/usr/bin/env bun
/**
 * Bakes the image every design's sandbox starts from (README.md), with BOAT_API_KEY set:
 *
 *   bun apps/runner/image/bake.ts                 build the runner, provision a fresh sandbox,
 *                                                 check it, save it, then check a new sandbox
 *                                                 made from the snapshot; skipped when a
 *                                                 snapshot of these inputs is already saved
 *   bun apps/runner/image/bake.ts --force         bake even so
 *   bun apps/runner/image/bake.ts verify [name]   check a saved snapshot again (current.json's)
 *   bun apps/runner/image/bake.ts list            this recipe's snapshots on the account
 *   bun apps/runner/image/bake.ts prune [--keep 3]   delete all but the newest few and current
 *
 * A bake that passes prints the snapshot's name and records it in current.json, which says
 * what the API's PONZU_SANDBOX_SNAPSHOT should be. Every sandbox it makes is destroyed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxProvider, Snapshot } from "@ponzu/sandbox";
import { bootChecks, imageChecks, runChecks } from "./checks.ts";
import { provider, scratch, sh, since, until, upload } from "./harness.ts";
import {
  inputsHash,
  type Pins,
  prunable,
  RUNNER,
  readPins,
  recipeInputs,
  SNAPSHOT_PREFIX,
  snapshotName,
  stage,
} from "./recipe.ts";
import { record, startTrial } from "./trial.ts";

const CURRENT = join(import.meta.dir, "current.json");
const SAVE_TIMEOUT_MS = 15 * 60_000;

interface Current {
  snapshot: string;
  inputs: string;
  bakedAt: string;
  sizeBytes: number | null;
  pins: Pins;
}

const [command = "bake", ...args] = process.argv.slice(2).filter((a) => a !== "--force");
const boat = provider();

switch (command) {
  case "bake":
    await bake(process.argv.includes("--force"));
    break;
  case "verify":
    await verify(boat, args[0] ?? readCurrent()?.snapshot ?? fail("no snapshot named"), readPins());
    break;
  case "list":
    for (const s of await ours()) console.log(describe(s));
    break;
  case "prune":
    await prune(Number(args[args.indexOf("--keep") + 1] ?? 3) || 3);
    break;
  default:
    fail(`unknown command ${command}`);
}

async function bake(force: boolean): Promise<void> {
  const built = spawnSync(process.execPath, ["scripts/build.ts", "--smoke"], {
    cwd: RUNNER,
    stdio: "inherit",
  });
  if (built.status !== 0) fail("the runner did not build");
  const pins = readPins();
  const inputs = recipeInputs(pins);
  const hash = inputsHash(inputs);
  const name = snapshotName(hash);
  console.log(`inputs ${hash}\nsnapshot ${name}`);

  const existing = await boat.getSnapshot(name);
  if (existing?.state === "ready" && !force) {
    console.log("already baked: these inputs are saved under that name");
    remember({ snapshot: name, inputs: hash, sizeBytes: existing.sizeBytes, pins }, existing);
    return;
  }

  const start = performance.now();
  const { sandbox } = await boat.create({
    idempotencyKey: `bake-${hash.slice(0, 12)}-${Date.now().toString(36)}`,
    name: `bake-${name}`,
    labels: { ponzu: "image-bake", image: name },
    autoStopSeconds: 3600,
  });
  console.log(`baking in ${sandbox.id}`);
  try {
    await boat.ensureAwake(sandbox.id);
    await scratch(async (dir) => {
      stage(dir, inputs, pins, hash);
      await upload(boat, sandbox.id, dir, "/tmp/ponzu-image");
    });
    await sh(boat, sandbox.id, "sudo bash /tmp/ponzu-image/provision.sh", { timeoutSeconds: 600 });
    console.log(`provisioned in ${since(start)} s; checking`);
    await runChecks(imageChecks(boat, sandbox.id, pins));
    await sh(boat, sandbox.id, "sync", { quiet: true });
    const saving = performance.now();
    await boat.saveSnapshot(sandbox.id, name);
    const saved = await until(
      `${name} to be saved`,
      async () => {
        const s = await boat.getSnapshot(name);
        if (s?.state === "failed") throw new Error(`saving failed: ${s.error}`);
        return s?.state === "ready" ? s : null;
      },
      SAVE_TIMEOUT_MS,
      2_000,
    );
    console.log(`saved in ${since(saving)} s: ${describe(saved)}`);
  } finally {
    await boat.destroy(sandbox.id);
  }

  try {
    await verify(boat, name, pins);
  } catch (err) {
    console.log(`${name} failed its checks from the snapshot, so it is deleted`);
    await boat.deleteSnapshot(name);
    throw err;
  }
  const saved = await boat.getSnapshot(name);
  remember({ snapshot: name, inputs: hash, sizeBytes: saved?.sizeBytes ?? null, pins }, saved);
  console.log(`baked ${name} in ${since(start)} s`);
}

/** The checks again, in a new sandbox made from the snapshot, as a design's would be. */
async function verify(boat: SandboxProvider, name: string, pins: Pins): Promise<void> {
  console.log(`checking ${name} from a new sandbox`);
  const trial = await startTrial(boat, name, {
    name: `verify-${name}`,
    label: "image-verify",
    // Claude Code starts on it; no turn runs.
    credential: { ANTHROPIC_API_KEY: "not-a-key" },
  });
  try {
    console.log(`  ${trial.id}: /health answered ${trial.healthAfter} s after the create call`);
    // The runner has its session and has started Claude Code, as the agent's user.
    await until(
      "the runner to start Claude Code",
      async () => (await record(trial)).items.some((i) => i.kind === "notice"),
      90_000,
    );
    await runChecks([...bootChecks(trial), ...imageChecks(boat, trial.id, pins)]);
  } finally {
    await boat.destroy(trial.id);
  }
}

async function prune(keep: number): Promise<void> {
  const current = readCurrent()?.snapshot ?? null;
  for (const s of prunable(await ours(), { keep, current })) {
    await boat.deleteSnapshot(s.name);
    console.log(`deleted ${describe(s)}`);
  }
  for (const s of await ours()) console.log(`kept ${describe(s)}`);
}

async function ours(): Promise<Snapshot[]> {
  return (await boat.listSnapshots()).filter((s) => s.name.startsWith(SNAPSHOT_PREFIX));
}

function describe(s: Snapshot): string {
  const mb = s.sizeBytes === null ? "?" : (s.sizeBytes / 2 ** 20).toFixed(0);
  return `${s.name}  ${s.state}  ${mb} MiB  ${new Date(s.createdAt).toISOString()}`;
}

function readCurrent(): Current | null {
  return existsSync(CURRENT) ? JSON.parse(readFileSync(CURRENT, "utf8")) : null;
}

/** current.json, for people and for whoever sets the API's PONZU_SANDBOX_SNAPSHOT. */
function remember(current: Omit<Current, "bakedAt">, saved: Snapshot | null): void {
  const record: Current = {
    ...current,
    bakedAt: new Date(saved?.createdAt ?? Date.now()).toISOString(),
  };
  writeFileSync(CURRENT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nPONZU_SANDBOX_SNAPSHOT=${current.snapshot}  (recorded in ${CURRENT})`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

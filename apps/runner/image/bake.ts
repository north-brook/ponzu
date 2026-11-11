#!/usr/bin/env bun
/**
 * Bakes the image every design's sandbox starts from (README.md), with BOAT_API_KEY set:
 *
 *   bun apps/runner/image/bake.ts                 build the runner, read boat's base in a fresh
 *                                                 sandbox, provision it, check it, save it, then
 *                                                 check a new sandbox made from the snapshot;
 *                                                 skipped when a snapshot of these inputs is
 *                                                 already saved and was checked
 *   bun apps/runner/image/bake.ts --force         bake even so
 *   bun apps/runner/image/bake.ts verify [name]   check a saved snapshot again (current.json's)
 *   bun apps/runner/image/bake.ts list            this recipe's snapshots on the account
 *   bun apps/runner/image/bake.ts prune [--keep 3]   delete all but the newest few and current
 *   bun apps/runner/image/bake.ts sweep           destroy every sandbox a bake, check or trial left
 *
 * A bake that passes prints the snapshot's name and records it in current.json, with when it
 * passed the checks from the snapshot: that record, not the snapshot being saved, is what says
 * an image may be used. Every sandbox it makes is destroyed, on Ctrl-C too.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxProvider, Snapshot } from "@ponzu/sandbox";
import { bootChecks, imageChecks, runChecks } from "./checks.ts";
import {
  destroyOnSignal,
  filesWithSecrets,
  provider,
  scratch,
  secretValues,
  sh,
  since,
  track,
  until,
  upload,
} from "./harness.ts";
import {
  BASE_FINGERPRINT,
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
import { endTrial, record, startTrial } from "./trial.ts";

const CURRENT = join(import.meta.dir, "current.json");
const SAVE_TIMEOUT_MS = 15 * 60_000;
/** What every sandbox the bake, its checks and the trials make is labelled with. */
const LABELS = ["image-bake", "image-verify", "image-e2e"];

interface Current {
  snapshot: string;
  inputs: string;
  /** A hash of what boat's base held when it was baked (recipe.ts, BASE_FINGERPRINT). */
  base: string;
  bakedAt: string;
  /** When it last passed every check in a sandbox made from it. */
  verifiedAt: string;
  sizeBytes: number | null;
  pins: Pins;
}

const [command = "bake", ...args] = process.argv.slice(2).filter((a) => a !== "--force");
const boat = provider();
destroyOnSignal();

switch (command) {
  case "bake":
    await bake(process.argv.includes("--force"));
    break;
  case "verify": {
    const current = readCurrent();
    const name = args[0] ?? current?.snapshot ?? fail("no snapshot named");
    await verify(boat, name, readPins());
    if (current?.snapshot === name) write({ ...current, verifiedAt: new Date().toISOString() });
    break;
  }
  case "list":
    for (const s of await ours()) console.log(describe(s));
    break;
  case "prune":
    await prune(Number(args[args.indexOf("--keep") + 1] ?? 3) || 3);
    break;
  case "sweep":
    for (const label of LABELS)
      for (const s of await boat.list({ labels: { ponzu: label } })) {
        await boat.destroy(s.id);
        console.log(`destroyed ${s.id} (${label}, ${s.state})`);
      }
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

  const start = performance.now();
  const { sandbox } = await boat.create({
    idempotencyKey: `bake-${Date.now().toString(36)}`,
    name: "bake-ponzu-runner",
    labels: { ponzu: "image-bake" },
    autoStopSeconds: 3600,
  });
  const untrack = track(boat, sandbox.id);
  console.log(`baking in ${sandbox.id}`);
  let name!: string;
  let current!: Omit<Current, "bakedAt" | "verifiedAt" | "sizeBytes">;
  try {
    await boat.ensureAwake(sandbox.id);
    // The base, as boat ships it today, is an input too: the name is known only once it is read.
    const base = await sh(boat, sandbox.id, BASE_FINGERPRINT, { quiet: true });
    const inputs = recipeInputs(pins, base);
    const hash = inputsHash(inputs);
    name = snapshotName(hash);
    current = { snapshot: name, inputs: hash, base: sha256(base).slice(0, 12), pins };
    console.log(`inputs ${hash}\nbase ${current.base}\nsnapshot ${name}`);

    const existing = await boat.getSnapshot(name);
    if (existing?.state === "ready" && !force) {
      await boat.destroy(sandbox.id);
      untrack();
      const known = readCurrent();
      if (known?.snapshot === name && known.verifiedAt) {
        console.log(`already baked and checked at ${known.verifiedAt}`);
        announce(name);
        return;
      }
      // Saved, but nothing says it passed: a bake that died between saving and checking.
      console.log("already saved, but not checked from the snapshot: checking it now");
      await verifyOrDelete(name, pins);
      remember(current, existing);
      return;
    }
    if (existing) await boat.deleteSnapshot(name);

    await scratch(async (dir) => {
      stage(dir, inputs, pins, hash);
      // What is uploaded is all that reaches the image from here: none of this machine's
      // secrets may be in it, whatever shape they have.
      const leaks = filesWithSecrets(dir, secretValues(process.env));
      if (leaks.length) throw new Error(`secrets in the image's inputs:\n${leaks.join("\n")}`);
      await upload(boat, sandbox.id, dir, "/tmp/ponzu-image");
    });
    await sh(boat, sandbox.id, "sudo bash /tmp/ponzu-image/provision.sh", { timeoutSeconds: 600 });
    console.log(`provisioned in ${since(start)} s; checking`);
    await runChecks(imageChecks(boat, sandbox.id, pins));
    await sh(boat, sandbox.id, "sync", { quiet: true });
    const saving = performance.now();
    try {
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
    } catch (err) {
      // A save boat finishes later must not be left under the name, unchecked.
      await boat.deleteSnapshot(name).catch(() => {});
      throw err;
    }
  } finally {
    await boat.destroy(sandbox.id);
    untrack();
  }

  await verifyOrDelete(name, pins);
  remember(current, await boat.getSnapshot(name));
  console.log(`baked ${name} in ${since(start)} s`);
}

async function verifyOrDelete(name: string, pins: Pins): Promise<void> {
  try {
    await verify(boat, name, pins);
  } catch (err) {
    console.log(`${name} failed its checks from the snapshot, so it is deleted`);
    await boat.deleteSnapshot(name);
    throw err;
  }
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
    await endTrial(trial);
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
function remember(
  current: Omit<Current, "bakedAt" | "verifiedAt" | "sizeBytes">,
  saved: Snapshot | null,
): void {
  write({
    snapshot: current.snapshot,
    inputs: current.inputs,
    base: current.base,
    bakedAt: new Date(saved?.createdAt ?? Date.now()).toISOString(),
    verifiedAt: new Date().toISOString(),
    sizeBytes: saved?.sizeBytes ?? null,
    pins: current.pins,
  });
  announce(current.snapshot);
}

function write(current: Current): void {
  writeFileSync(CURRENT, `${JSON.stringify(current, null, 2)}\n`);
}

function announce(name: string): void {
  console.log(`\nPONZU_SANDBOX_SNAPSHOT=${name}  (recorded in ${CURRENT})`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

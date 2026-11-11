#!/usr/bin/env bun
/**
 * What exists at Vercel for the API's project: every sandbox and every snapshot not yet
 * deleted. With `--delete-spike`, deletes the sandboxes whose name starts `ponzu-spike-` and
 * their snapshots (what vercel-e2e.ts leaves when it is cut short).
 *
 *   bun apps/runner/image/vercel-inventory.ts [--delete-spike]
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { credentials } from "./vercel.ts";

const c = credentials();
if (process.argv.includes("--delete-spike")) {
  for (const s of await (await Sandbox.list({ ...c, namePrefix: "ponzu-spike-" })).toArray()) {
    const sb = await Sandbox.get({ ...c, name: s.name, resume: false });
    await sb.delete({ deleteOrphanSnapshots: true });
    console.log(`deleted ${s.name}`);
  }
}
const sandboxes = await (await Sandbox.list({ ...c })).toArray();
console.log(
  JSON.stringify({ sandboxes: sandboxes.map((s) => ({ name: s.name, status: s.status })) }),
);
const snapshots = (await (await Snapshot.list({ ...c })).toArray()).filter(
  (s) => s.status !== "deleted",
);
console.log(
  JSON.stringify({
    snapshots: snapshots.map((s) => ({
      id: s.id,
      status: s.status,
      MiB: Math.round(s.sizeBytes / 1048576),
      createdAt: new Date(s.createdAt).toISOString(),
    })),
  }),
);

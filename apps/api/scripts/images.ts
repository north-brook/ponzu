// `bun scripts/images.ts`: where a rollout of a new sandbox image stands. For every design's
// sandbox: the image it was made from, what its runner says it runs, and what its next wake will
// do about PONZU_SANDBOX_SNAPSHOT (docs/cloud.md, "How images roll out"). It only reads.
//
// The database is DATABASE_URL, or the Neon branch named by --branch (default "dev") when
// NEON_API_KEY and NEON_PROJECT_ID are set, as `bun run dev` finds it. The image it compares
// against is PONZU_SANDBOX_SNAPSHOT, which must be what the deployed API has. `--json` prints
// the rows as JSON.
import { createDb, getCheckpointCover, listSandboxImages } from "@ponzu/db";
import { rollout } from "../src/sandboxes/rollout.ts";
import { branchDatabaseUrl } from "./neon.ts";

const { env } = process;
const args = process.argv.slice(2);
const named = args.indexOf("--branch");
const branch = (named >= 0 && args[named + 1]) || "dev";
const image = env.PONZU_SANDBOX_SNAPSHOT;
if (!image) throw new Error("Set PONZU_SANDBOX_SNAPSHOT to the image the deployed API has.");

const url =
  env.DATABASE_URL ||
  (env.NEON_API_KEY && env.NEON_PROJECT_ID
    ? await branchDatabaseUrl(branch, { apiKey: env.NEON_API_KEY, projectId: env.NEON_PROJECT_ID })
    : null);
if (!url) throw new Error("Set DATABASE_URL, or NEON_API_KEY and NEON_PROJECT_ID.");

const db = createDb(url);
const sandboxes = await listSandboxImages(db);
const covers = new Map(
  await Promise.all(
    sandboxes.map(
      async ({ sandbox }) =>
        [sandbox.designId, await getCheckpointCover(db, sandbox.designId)] as const,
    ),
  ),
);
const rows = rollout(sandboxes, covers, {
  image,
  maxMoves: Number(env.PONZU_SANDBOX_MAX_MOVES ?? 3),
});

if (args.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const SAYS = {
    current: "on the current image",
    moves: "moves at its next wake",
    moves_after_sleep: "moves at the first wake after it next sleeps",
    moves_after_a_checkpoint:
      "its next wake resumes it to save a checkpoint; the one after moves it",
    stays_image_failed: "stays: a move onto this image failed for it (see sandbox_move_failed)",
    stays_no_checkpoint:
      "stays: its runner has saved no checkpoint, so a move would lose its conversation and unpushed work",
    stays_moving_off: "stays: PONZU_SANDBOX_MAX_MOVES is 0",
    retired: "settled: the sweep destroys it",
  } as const;
  console.log(`Current image: ${image}\n`);
  for (const row of rows) {
    console.log(
      `${row.designId}  ${row.state.padEnd(8)} gen ${row.generation}  ${row.image ?? "(not recorded)"}` +
        `  runner says ${row.runnerImage ?? "(nothing)"}\n    ${SAYS[row.next]}`,
    );
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.next, (counts.get(row.next) ?? 0) + 1);
  const totals = [...counts].map(([next, count]) => `${count} ${next}`).join(", ");
  console.log(`\n${totals || "No sandboxes."}`);
}

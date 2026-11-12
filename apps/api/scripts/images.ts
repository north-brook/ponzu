// `bun scripts/images.ts`: where a rollout of a new sandbox image stands. For every canvas's
// sandbox: the image it runs, what its runner says it is, and what its next wake will do about
// the image this checkout ships, apps/runner/image/current.json (docs/cloud.md, "How images roll
// out"). It only reads. Run it from the commit the deployed API was built from.
//
// The database is DATABASE_URL, or the Neon branch named by --branch (default "dev") when
// NEON_API_KEY and NEON_PROJECT_ID are set, as `bun run dev` finds it. `--json` prints the rows
// as JSON.
import { createDb, getCheckpointCover, listSandboxImages } from "@ponzu/db";
import current from "@ponzu/runner/image/current.json" with { type: "json" };
import { rollout } from "../src/sandboxes/rollout.ts";
import { branchDatabaseUrl } from "./neon.ts";

const { env } = process;
const args = process.argv.slice(2);
const named = args.indexOf("--branch");
const branch = (named >= 0 && args[named + 1]) || "dev";
const image = current.image;

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
        [sandbox.canvasId, await getCheckpointCover(db, sandbox.canvasId)] as const,
    ),
  ),
);
const rows = rollout(sandboxes, covers, { image });

if (args.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const SAYS = {
    current: "on the current image",
    recreates: "is recreated on it at its next wake",
    recreates_after_sleep: "is recreated at the first wake after it next sleeps",
    recreates_after_a_checkpoint:
      "its next wake resumes it to save a checkpoint; a later one recreates it",
    stays_no_checkpoint:
      "stays: its runner has saved no checkpoint, so a recreate would lose its conversation and unpushed work",
    retired: "settled: the sweep retires it",
  } as const;
  console.log(`Current image: ${image}\n`);
  for (const row of rows) {
    console.log(
      `${row.canvasId}  ${row.state.padEnd(8)} ${row.image ?? "(no session yet)"}` +
        `  runner says ${row.client ?? "(nothing)"}\n    ${SAYS[row.next]}`,
    );
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.next, (counts.get(row.next) ?? 0) + 1);
  const totals = [...counts].map(([next, count]) => `${count} ${next}`).join(", ");
  console.log(`\n${totals || "No sandboxes."}`);
}

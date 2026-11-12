// Seal again, under PONZU_VAULT_KEY, every stored value an older vault key sealed, so the
// older key can leave PONZU_VAULT_OLD_KEYS. The rotation, in order (docs/production.md,
// "Secrets rotation"):
//
//   1. set the new PONZU_VAULT_KEY and move the old one into PONZU_VAULT_OLD_KEYS; deploy;
//   2. once that deployment serves every request, run this with the same three values the
//      deployment has:
//
//        DATABASE_URL=… PONZU_VAULT_KEY=… PONZU_VAULT_OLD_KEYS=… bun scripts/reseal.ts [--dry-run] [--json]
//
//   3. run it until it reports nothing left (the selfcheck's `vault_old_keys` reads 0), then
//      drop the old key and deploy.
//
// Running it before step 1's deployment is live would seal values with a key the API does not
// hold yet. Each value is written back in its own statement only if the row still holds what was
// read, so it can be stopped and run again at any point. `--dry-run` opens every value and writes
// nothing. DATABASE_URL is Neon's pooled URL, as the API takes it.
//
// It prints counts per column and key id, and the rows it could not seal again (their ids and
// secret names), never a value or a key. It exits 1 while any stored value is still under
// another key: one it could not open, a GitHub token that was mid-refresh, or one an older
// deployment wrote meanwhile.
import { createDb } from "@ponzu/db";
import { type ResealReport, resealAll } from "../src/vault/reseal.ts";
import { createVault } from "../src/vault/vault.ts";

const { env } = process;
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--dry-run" && arg !== "--json");
if (!env.DATABASE_URL || !env.PONZU_VAULT_KEY || unknown.length > 0) {
  console.error(
    "usage: DATABASE_URL=… PONZU_VAULT_KEY=… PONZU_VAULT_OLD_KEYS=… bun scripts/reseal.ts [--dry-run] [--json]",
  );
  process.exit(2);
}
const oldKeys = env.PONZU_VAULT_OLD_KEYS?.split(",").filter(Boolean) ?? [];
if (oldKeys.length === 0) {
  console.error("PONZU_VAULT_OLD_KEYS is empty: there is no old key to seal away from.");
  process.exit(2);
}

const report = await resealAll(
  { db: createDb(env.DATABASE_URL), vault: createVault({ key: env.PONZU_VAULT_KEY, oldKeys }) },
  { dryRun: args.includes("--dry-run") },
);
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : describe(report));
// A dry run fails only on what a real run could not mend; a real run, on anything still old.
if (report.dryRun ? report.failures.length > 0 : report.remaining > 0) process.exitCode = 1;

function describe({ currentKeyId, dryRun, counts, failures, remaining }: ResealReport): string {
  const lines = [
    `${dryRun ? "Dry run: nothing written. " : ""}The current key is ${currentKeyId}.`,
  ];
  if (counts.length === 0) lines.push("Every sealed value is already under the current key.");
  for (const { binding, keyId, resealed, changed, failed } of counts) {
    lines.push(
      `${binding} from ${keyId}: ${resealed} ${dryRun ? "would be sealed again" : "sealed again"}, ` +
        `${changed} rewritten or busy meanwhile, ${failed} could not be opened`,
    );
  }
  for (const { binding, row, keyId, reason } of failures) {
    lines.push(`could not be opened: ${binding} ${row} (key ${keyId}): ${reason}`);
  }
  const values = `${remaining} ${remaining === 1 ? "value is" : "values are"}`;
  if (dryRun) lines.push(`${values} under another key now.`);
  else if (remaining === 0) lines.push("Nothing is left under another key: the old key can go.");
  else {
    const again = failures.length < remaining ? " and run this again" : "";
    lines.push(`${values} still under another key. Keep the old key${again}.`);
  }
  return lines.join("\n");
}

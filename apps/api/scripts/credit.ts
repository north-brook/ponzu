// Credit a workspace, or take credits back: support's adjustment to its free credits for the
// billing period running now (docs/cloud.md, "Billing"). For an outage, a goodwill credit, or a
// correction:
//
//   DATABASE_URL=… bun scripts/credit.ts <workspace id> <credits> "<note>"
//
// <credits> is a whole number and not zero; a negative one takes credits away (never below
// zero free credits in all). The note says why, and is kept with the ledger row. It writes one
// `adjustment` row in `credit_ledger` and prints its id and the period it counts in. Run twice,
// it adjusts twice. DATABASE_URL is Neon's pooled URL, as the API takes it.
import { createDb } from "@ponzu/db";
import { adjustWorkspaceCredits } from "../src/billing/adjust.ts";

const { env } = process;
const [workspaceId, amount, note, ...rest] = process.argv.slice(2);
const credits = Number(amount);
if (
  !env.DATABASE_URL ||
  !workspaceId ||
  !note?.trim() ||
  rest.length > 0 ||
  !Number.isInteger(credits) ||
  credits === 0
) {
  console.error('usage: DATABASE_URL=… bun scripts/credit.ts <workspace id> <credits> "<note>"');
  console.error("<credits> is a whole number, not zero; negative takes credits away.");
  process.exit(2);
}

try {
  const { id, period } = await adjustWorkspaceCredits(createDb(env.DATABASE_URL), {
    workspaceId,
    credits,
    note,
    now: new Date(),
  });
  console.log(
    `${credits > 0 ? "Credited" : "Took back"} ${Math.abs(credits)} credits for the period ` +
      `${period.start.toISOString()} to ${period.end.toISOString()} (${id}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

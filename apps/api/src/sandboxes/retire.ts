import { listLiveSandboxes, moveSandbox, revokeRunnerTokens, SANDBOX_STATES } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/*
 * A design that is settled or deleted needs no sandbox (docs/cloud.md, "Settle"). Its rows go
 * first, which meters what was awake and revokes its runner tokens, so the runner hears at its
 * next call that it is done; then the provider destroys the machines. A destroy that fails
 * leaves a sandbox the database no longer knows, which the minute's sweep finds by its labels.
 */

const LIVE = SANDBOX_STATES.filter((state) => state !== "gone");

/**
 * Mark the design's sandboxes gone and revoke its runner tokens. Answers the provider sandboxes
 * to destroy. Call it before deleting a design: its usage is put down to its workspace from the
 * design's row.
 */
export async function retireSandboxes(
  deps: Pick<Deps, "db" | "clock">,
  designId: string,
): Promise<string[]> {
  const now = new Date(deps.clock.now());
  const rows = await listLiveSandboxes(deps.db, designId);
  const retired = await Promise.all(
    rows.map((row) => moveSandbox(deps.db, { id: row.id, from: LIVE, to: "gone", now })),
  );
  await revokeRunnerTokens(deps.db, designId);
  return retired.flatMap((row) => (row?.providerId ? [row.providerId] : []));
}

/** Destroy sandboxes at the provider. A failure is logged; the sweep tries again. */
export async function destroySandboxes(
  deps: Pick<Deps, "sandbox" | "log">,
  providerIds: string[],
): Promise<void> {
  await Promise.all(
    providerIds.map(async (id) => {
      try {
        await deps.sandbox.destroy(id);
      } catch (error) {
        deps.log.warn("sandbox_destroy_failed", { providerSandboxId: id, error });
      }
    }),
  );
}

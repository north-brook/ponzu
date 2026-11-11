import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { designs, sandboxes } from "../schema/index.ts";
import { run } from "./run.ts";

/**
 * Where the API reaches the runner of a design whose sandbox is awake: the address and its
 * token, sealed. Null when the design has no awake sandbox with an address on record.
 */
export async function getAwakeSandboxAddress(
  db: Db,
  designId: string,
): Promise<{ sandboxId: string; address: string; encryptedAddressToken: string | null } | null> {
  const [row] = await run(
    db
      .select({
        sandboxId: sandboxes.id,
        address: sandboxes.address,
        encryptedAddressToken: sandboxes.encryptedAddressToken,
      })
      .from(designs)
      .innerJoin(sandboxes, eq(sandboxes.id, designs.sandboxId))
      .where(
        and(eq(designs.id, designId), eq(sandboxes.state, "awake"), isNotNull(sandboxes.address)),
      ),
  );
  return row ? { ...row, address: row.address! } : null;
}

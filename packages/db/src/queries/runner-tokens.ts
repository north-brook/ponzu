import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId, randomString } from "../ids.ts";
import { canvasRunners, runnerTokens } from "../schema/index.ts";
import { run } from "./run.ts";

/**
 * Make a token a runner signs in with. It is good for one canvas until it expires or is
 * revoked. The token itself is returned here and nowhere else; the table keeps its hash.
 */
export async function createRunnerToken(
  db: Db,
  { canvasId, ttlSeconds }: { canvasId: string; ttlSeconds: number },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  // 260 random bits, so a plain hash is enough: there is nothing to guess.
  const token = `pzr_${randomString(52)}`;
  const [row] = await run(
    db
      .insert(runnerTokens)
      .values({
        id: newId("rt"),
        canvasId,
        tokenHash: await hash(token),
        expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
      })
      .returning({ id: runnerTokens.id, expiresAt: runnerTokens.expiresAt }),
  );
  return { ...row!, token };
}

/**
 * The canvas a token is good for, with the runner that holds the canvas's lease now (null
 * before any has started), or null if the token is unknown, expired or revoked.
 */
export async function verifyRunnerToken(
  db: Db,
  token: string,
): Promise<{ id: string; canvasId: string; leaseRunnerId: string | null } | null> {
  const [row] = await run(
    db
      .select({
        id: runnerTokens.id,
        canvasId: runnerTokens.canvasId,
        leaseRunnerId: canvasRunners.runnerId,
      })
      .from(runnerTokens)
      .leftJoin(canvasRunners, eq(canvasRunners.canvasId, runnerTokens.canvasId))
      .where(
        and(
          eq(runnerTokens.tokenHash, await hash(token)),
          isNull(runnerTokens.revokedAt),
          gt(runnerTokens.expiresAt, sql`now()`),
        ),
      ),
  );
  return row ?? null;
}

/** Revoke one token, as one issued for a start that did not happen. */
export async function revokeRunnerToken(db: Db, id: string): Promise<void> {
  await run(
    db
      .update(runnerTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(runnerTokens.id, id), isNull(runnerTokens.revokedAt))),
  );
}

/**
 * Revoke every token a canvas's runners hold, as when its sandbox is destroyed, or every one but
 * `except`, the one its sandbox now runs on. Answers how many.
 */
export async function revokeRunnerTokens(
  db: Db,
  canvasId: string,
  { except }: { except?: string | null } = {},
): Promise<number> {
  const revoked = await run(
    db
      .update(runnerTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(runnerTokens.canvasId, canvasId),
          isNull(runnerTokens.revokedAt),
          except ? ne(runnerTokens.id, except) : undefined,
        ),
      )
      .returning({ id: runnerTokens.id }),
  );
  return revoked.length;
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

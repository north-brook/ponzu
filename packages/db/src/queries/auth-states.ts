import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { authStates, type Json } from "../schema/index.ts";
import { run } from "./run.ts";

export type AuthState = typeof authStates.$inferSelect;

/** Begin a round trip through someone else's page. Its id is what comes back to say whose it is. */
export async function createAuthState(
  db: Db,
  state: { kind: AuthState["kind"]; userId: string; payload: Json; expiresAt: Date },
): Promise<AuthState> {
  const [row] = await run(
    db
      .insert(authStates)
      .values({ id: newId("auth"), ...state })
      .returning(),
  );
  return row!;
}

/** A round trip of this kind that `userId` began, whatever has become of it since. */
export async function getAuthState(
  db: Db,
  { id, kind, userId }: { id: string; kind: AuthState["kind"]; userId: string },
): Promise<AuthState | null> {
  const [row] = await run(
    db
      .select()
      .from(authStates)
      .where(and(eq(authStates.id, id), eq(authStates.kind, kind), eq(authStates.userId, userId))),
  );
  return row ?? null;
}

/**
 * Take a round trip's state as it comes back, once. Null if it is of another kind, has run out
 * at `now`, or was taken before: the first caller gets it and every later one gets nothing, so
 * a state replayed from a browser's history or a log is worth nothing.
 */
export async function consumeAuthState(
  db: Db,
  { id, kind, now }: { id: string; kind: AuthState["kind"]; now: Date },
): Promise<AuthState | null> {
  const [row] = await run(
    db
      .update(authStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authStates.id, id),
          eq(authStates.kind, kind),
          isNull(authStates.consumedAt),
          gt(authStates.expiresAt, now),
        ),
      )
      .returning(),
  );
  return row ?? null;
}

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type CanvasDriverView, canvasDrivers, canvases } from "../schema/index.ts";
import { run } from "./run.ts";

/*
 * A person's own agent driving a canvas in place of Ponzu's agent (docs/cloud.md, "Driving a
 * canvas"). The lease is `canvas_drivers`; `canvases.driver` says who holds it, for the head, and
 * is written in the same statement as the lease, so the two never disagree for long. A lease
 * unseen for `DRIVER_LEASE_SECONDS` is over: every read here treats it as over at once, and the
 * sweep takes it away (`listLapsedDrivers`, `releaseCanvasDriver`).
 */

export type CanvasDriver = typeof canvasDrivers.$inferSelect;

/** How long a lease lasts without a call from its agent. */
export const DRIVER_LEASE_SECONDS = 30 * 60;

const live = sql`${canvasDrivers.seenAt} >= now() - make_interval(secs => ${DRIVER_LEASE_SECONDS})`;

export interface DriverClaim {
  canvasId: string;
  grantId: string;
  userId: string;
  client: string;
  name: string;
  host: string | null;
  version: string | null;
}

/**
 * Take the canvas for an agent: answers the lease it now holds, or the one that holds it. A
 * lease is taken over only from another of the same person's agents, or once it is over; never
 * from someone else's live one. Taking it again renews it.
 */
export async function takeCanvasDriver(
  db: Db,
  claim: DriverClaim,
): Promise<{ taken: true; driver: CanvasDriver } | { taken: false; holder: CanvasDriver }> {
  const view: Omit<CanvasDriverView, "since"> = {
    client: claim.client,
    name: claim.name,
    host: claim.host,
    userId: claim.userId,
  };
  await run(
    db.execute(sql`
      with taken as (
        insert into ${canvasDrivers} (canvas_id, grant_id, user_id, client, name, host, version)
        values (${claim.canvasId}, ${claim.grantId}, ${claim.userId}, ${claim.client},
                ${claim.name}, ${claim.host}, ${claim.version})
        on conflict (canvas_id) do update
          set grant_id = excluded.grant_id, user_id = excluded.user_id, client = excluded.client,
              name = excluded.name, host = excluded.host, version = excluded.version,
              started_at = case when ${canvasDrivers.grantId} = excluded.grant_id
                                 then ${canvasDrivers.startedAt} else now() end,
              seen_at = now()
          where ${canvasDrivers.userId} = excluded.user_id
             or ${canvasDrivers.seenAt} < now() - make_interval(secs => ${DRIVER_LEASE_SECONDS})
        returning canvas_id, started_at
      )
      update ${canvases}
         set driver = ${JSON.stringify(view)}::jsonb
                      || jsonb_build_object('since', (select started_at from taken))
       where id in (select canvas_id from taken)
    `),
  );
  const [row] = await run(
    db.select().from(canvasDrivers).where(eq(canvasDrivers.canvasId, claim.canvasId)),
  );
  if (!row) throw new Error("takeCanvasDriver: the lease is gone");
  return row.grantId === claim.grantId
    ? { taken: true, driver: row }
    : { taken: false, holder: row };
}

/** The canvas's lease while it is live; null when nobody drives it, or its lease is over. */
export async function getCanvasDriver(db: Db, canvasId: string): Promise<CanvasDriver | null> {
  const [row] = await run(
    db
      .select()
      .from(canvasDrivers)
      .where(and(eq(canvasDrivers.canvasId, canvasId), live)),
  );
  return row ?? null;
}

/**
 * Renew the lease of an agent's call: answers whether this grant still holds it. A lease that
 * was over, or another's, is not renewed.
 */
export async function touchCanvasDriver(
  db: Db,
  { canvasId, grantId }: { canvasId: string; grantId: string },
): Promise<boolean> {
  const [row] = await run(
    db
      .update(canvasDrivers)
      .set({ seenAt: sql`now()` })
      .where(and(eq(canvasDrivers.canvasId, canvasId), eq(canvasDrivers.grantId, grantId), live))
      .returning({ canvasId: canvasDrivers.canvasId }),
  );
  return Boolean(row);
}

/**
 * End the canvas's lease: the agent let it go, the person took it back, the sweep found it over.
 * With `grantId`, only that grant's; with `lapsed`, only one that is over. Answers the lease that
 * ended, or null when there was none to end.
 */
export async function releaseCanvasDriver(
  db: Db,
  { canvasId, grantId, lapsed = false }: { canvasId: string; grantId?: string; lapsed?: boolean },
): Promise<CanvasDriver | null> {
  const result = await run(
    db.execute(sql`
      with gone as (
        delete from ${canvasDrivers}
         where canvas_id = ${canvasId}
           ${grantId ? sql`and grant_id = ${grantId}` : sql``}
           ${lapsed ? sql`and seen_at < now() - make_interval(secs => ${DRIVER_LEASE_SECONDS})` : sql``}
        returning *
      ), cleared as (
        update ${canvases} set driver = null where id in (select canvas_id from gone) returning id
      )
      select gone.canvas_id as "canvasId", gone.grant_id as "grantId", gone.user_id as "userId",
             gone.client, gone.name, gone.host, gone.version,
             gone.started_at as "startedAt", gone.seen_at as "seenAt"
        from gone
    `),
  );
  const [row] = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  if (!row) return null;
  return {
    ...(row as unknown as CanvasDriver),
    startedAt: new Date(row.startedAt as string),
    seenAt: new Date(row.seenAt as string),
  };
}

/** The canvases a grant drives now: every lease it holds, live or over. */
export async function listGrantDrivers(db: Db, grantId: string): Promise<string[]> {
  const rows = await run(
    db
      .select({ canvasId: canvasDrivers.canvasId })
      .from(canvasDrivers)
      .where(eq(canvasDrivers.grantId, grantId)),
  );
  return rows.map((row) => row.canvasId);
}

/** Leases unseen for longer than a lease lasts, oldest first: the sweep ends them. */
export async function listLapsedDrivers(db: Db, limit = 50): Promise<string[]> {
  const rows = await run(
    db
      .select({ canvasId: canvasDrivers.canvasId })
      .from(canvasDrivers)
      .where(lt(canvasDrivers.seenAt, sql`now() - make_interval(secs => ${DRIVER_LEASE_SECONDS})`))
      .orderBy(canvasDrivers.seenAt)
      .limit(limit),
  );
  return rows.map((row) => row.canvasId);
}

/** Whether the canvas is driven now: a live lease. */
export async function isCanvasDriven(db: Db, canvasId: string): Promise<boolean> {
  const [row] = await run(
    db
      .select({ canvasId: canvasDrivers.canvasId })
      .from(canvasDrivers)
      .where(
        and(
          eq(canvasDrivers.canvasId, canvasId),
          gte(canvasDrivers.seenAt, sql`now() - make_interval(secs => ${DRIVER_LEASE_SECONDS})`),
        ),
      ),
  );
  return Boolean(row);
}

import { cutAwake, listAwakeToMeter } from "@ponzu/db";
import type { JobDeps } from "../jobs/run.ts";
import { billingPeriod } from "./period.ts";

/*
 * The meter (docs/cloud.md, "Billing"). A sandbox's awake time becomes a usage event when it
 * leaves `awake`, dated when the stretch began. Left at that, a long stretch would land whole in
 * the period it began in, even the part after that period ended and was billed. So while billing
 * is on (observe or on), the minute's sweep cuts every awake stretch, before anything else it
 * does: at the end of the billing period it began in, and otherwise once it has run an hour. Each
 * cut meters the piece so far, exactly as a sleep would (`cutAwake`), and the stretch goes on from
 * the cut. A cut holds to the stretch it saw, so a sleep or another sweep at the same moment
 * never meters a second twice or loses one.
 *
 * While billing is off the meter does nothing: nothing is cut or written, and awake time is
 * metered as it always was, a stretch at a time.
 */

/** An awake stretch is cut once it has run this long. */
export const CUT_EVERY_MS = 60 * 60_000;
/**
 * Cuts of one sandbox in one run, at most: a sweep that was down catches up over a few minutes.
 * A move out of `awake` tries one more time than this (`MOVE_ATTEMPTS` in the database's
 * `queries/sandboxes.ts`), so it outlasts a run's cuts; raise both together.
 */
export const MAX_CUTS_PER_RUN = 3;

/**
 * Where to cut a stretch awake since `awakeSince` at `now`, or null for not yet: at the end of
 * the billing period it began in, once that has passed; else, once it has run an hour, at the
 * last whole second before `now`, so the piece metered is a whole number of seconds and the
 * pieces add up to the stretch exactly.
 */
export function nextCut(awakeSince: Date, anchor: Date, now: Date): Date | null {
  const { end } = billingPeriod(anchor, awakeSince);
  if (end.getTime() <= now.getTime()) return end;
  const ran = now.getTime() - awakeSince.getTime();
  if (ran < CUT_EVERY_MS) return null;
  return new Date(awakeSince.getTime() + Math.floor(ran / 1000) * 1000);
}

/**
 * Cut every awake stretch that is due, at most `MAX_CUTS_PER_RUN` times each. Answers how many
 * cuts were made. One sandbox's failure is logged and leaves the others.
 */
export async function meterAwake(deps: JobDeps, now: Date): Promise<number> {
  const rows = await listAwakeToMeter(deps.db);
  let cuts = 0;
  await Promise.all(
    rows.map(async (row) => {
      let since = row.awakeSince;
      try {
        for (let i = 0; i < MAX_CUTS_PER_RUN; i++) {
          const at = nextCut(since, row.periodAnchor, now);
          if (!at) break;
          // Lost to a sleep or another cut: whoever won metered it.
          if (!(await cutAwake(deps.db, { canvasId: row.canvasId, at, observedSince: since }))) {
            break;
          }
          cuts++;
          since = at;
        }
      } catch (error) {
        deps.log.warn("sweep_failed", { canvasId: row.canvasId, step: "meter", error });
        deps.analytics.exception(error, { sweep_step: "meter", canvas_id: row.canvasId });
      }
    }),
  );
  return cuts;
}

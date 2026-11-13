import { SEARCH_VERSION } from "@ponzu/core";
import { queueSearchBackfill } from "@ponzu/db";
import type { CronStep } from "../steps.ts";

/** How many reindexes may wait at once; each run queues up to this many less those waiting. */
const BACKFILL_LIMIT = 25;

/**
 * Queue a reindex for canvases no reindex has done at this SEARCH_VERSION: every canvas from
 * before search, and every one after a version bump. The jobs step runs them. A canvas made
 * since search has its entries from its create, so in a new environment this queues nothing.
 */
export const searchBackfillStep: CronStep = {
  name: "search_backfill",
  run: async (deps, now) => ({
    queued: await queueSearchBackfill(deps.db, {
      limit: BACKFILL_LIMIT,
      version: SEARCH_VERSION,
      now,
    }),
  }),
};

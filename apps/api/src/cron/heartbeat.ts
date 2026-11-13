import { type Db, readHeartbeat, recordHeartbeat } from "@ponzu/db";

/*
 * When the minute's cron last ran, so that a scheduler that stopped is noticed in minutes
 * rather than when sandboxes stop sleeping. Each run of `GET /v1/cron/minute` records its time
 * here before its steps; the selfcheck's `cron_fresh`, `GET /v1/health`'s `cron.lastRanAt` and
 * production's uptime check read it.
 *
 * It is one row in `jobs` (`recordHeartbeat`), so it needs no migration. The record belongs to
 * the database, not to a deployment: every deployment on one database reads the same time, and
 * a preview, which never runs the minute, reads dev's.
 */

/** The heartbeat's name. */
export const CRON_HEARTBEAT = "cron.minute";

/**
 * How old the last run may be and the minute still count as running: five missed minutes.
 * Vercel delivers a run up to a minute late (the jitter), and a late occurrence is still
 * delivered within about ten minutes, so a gap of five is a scheduler that is not running,
 * not one that is slow.
 */
export const CRON_FRESH_MS = 5 * 60_000;

/** Record that the minute ran at `at`. A time older than the one recorded leaves it. */
export function recordCronRun(db: Db, at: Date): Promise<void> {
  return recordHeartbeat(db, CRON_HEARTBEAT, at);
}

/** When the minute last ran on this database, or null when it never has. */
export function lastCronRun(db: Db): Promise<Date | null> {
  return readHeartbeat(db, CRON_HEARTBEAT);
}

/** Whether a run at `lastRanAt` is recent enough at `now`. */
export function isCronFresh(lastRanAt: Date, now: number): boolean {
  return now - lastRanAt.getTime() < CRON_FRESH_MS;
}

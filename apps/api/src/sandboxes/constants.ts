/*
 * The numbers a design's sandbox lives by (docs/cloud.md, "The sandbox").
 */

/**
 * A session's own timeout at Vercel: the backstop for when the API is not there to stop it. The
 * sweep extends it while the sandbox is awake.
 */
export const SESSION_TIMEOUT_MS = 30 * 60_000;
/** The sweep extends a session once its deadline is closer than this... */
export const EXTEND_WITHIN_MS = 10 * 60_000;
/** ...by this much. */
export const EXTEND_BY_MS = 20 * 60_000;
/** The most one session may run, on Vercel's Pro plan. Extending past it is refused. */
export const MAX_SESSION_MS = 24 * 3600_000;
/** What an extend keeps clear of that cap. */
export const EXTEND_MARGIN_MS = 5 * 60_000;
/** A session this old is put to sleep (and woken again if there is work) before it hits the cap. */
export const SESSION_CYCLE_MS = 23.5 * 3600_000;
/**
 * ...unless a turn is under way or owed: then it waits for the turn until this old, which leaves
 * ten minutes before the furthest deadline an extend gives (the cap less its margin).
 */
export const SESSION_CYCLE_BUSY_MS = MAX_SESSION_MS - 15 * 60_000;
/**
 * How long Vercel keeps a design's snapshot after its last use. Past it the next wake boots an
 * empty disk and the runner rebuilds from git and the last checkpoint.
 */
export const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 3600_000;
/** A runner token is made at every start and outlives the longest session. */
export const RUNNER_TOKEN_SECONDS = 25 * 3600;
/** How long `ponzu-stop` may take: the runner's shutdown (20 s at most), its lock, and `sync`. */
export const STOP_COMMAND_MS = 30_000;
/** The size of a design's sandbox: 2 vCPUs and 4 GB. */
export const SANDBOX_VCPUS = 2 as const;

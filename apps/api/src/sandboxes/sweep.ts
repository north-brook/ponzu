import {
  appendThreadItemOnce,
  countSandboxRestart,
  getDesign,
  getSandboxOwners,
  lapseEvents,
  listSandboxesToSweep,
  moveSandbox,
  type SandboxRow,
  type SweptSandbox,
  setSandboxExpiry,
  showAgentWaiting,
  WAKING_LEASE_MS,
} from "@ponzu/db";
import { parseSandboxName, type SandboxInfo, scopePrefix } from "@ponzu/sandbox";
import type { ServerEvents } from "../analytics/events.ts";
import type { JobDeps } from "../jobs/run.ts";
import {
  EXTEND_BY_MS,
  EXTEND_MARGIN_MS,
  EXTEND_WITHIN_MS,
  MAX_SESSION_MS,
  SESSION_CYCLE_MS,
} from "./constants.ts";
import { runnerTarget } from "./environment.ts";
import { sandboxName } from "./orchestrate.ts";
import { retire } from "./retire.ts";
import { captureSlept, putToSleep, wakeIfPending } from "./stop.ts";

/*
 * The minute's look over every sandbox that costs something or is moving (docs/cloud.md, "The
 * sandbox"). It never resumes anything: every call it makes is pinned to a session, or reads.
 * Each sandbox gets at most one step, the first that applies, in this order:
 *
 *   retire     the design is settled
 *   stop       its Claude can no longer run it, or its owner left the workspace
 *   restart    awake and its runner unheard for 90 s (after 3 in a row, it fails)
 *   lapse      a turn it owes is past waiting for (docs/cloud.md, "A turn that never came")
 *   stalled    its runner says it works and has written nothing for an hour
 *   sleep      idle for the idle window, owing no turn
 *   cycle      its session is 23.5 hours old: slept, then woken if there is work
 *   extend     its session's deadline is less than 10 minutes off
 *   repair     a waking or stopping row left past its lease
 *
 * and every tenth minute, `reconcile` compares this database's names at Vercel with its rows.
 * Each step is a move that holds to the state it moves from, so two sweeps at once, or a sweep
 * and a wake, cannot both act on one sandbox.
 */

/** A runner unheard from for this long (the heartbeat is every 30 s) is taken as dead. */
export const DEAD_AFTER_MS = 90_000;
/** Restarts in a row of a runner that never answers before the sandbox is failed. */
const MAX_RESTARTS = 3;
/** Reconcile runs on minutes divisible by this, and acts at most `RECONCILE_ACTIONS` times. */
const RECONCILE_EVERY_MINUTES = 10;
/** Vercel caps deletes at 20 a second per team; a run stays well under that. */
const RECONCILE_ACTIONS = 10;
/** A sign-in's sandbox this old, or whose sign-in is over, is removed by reconcile. */
const SIGN_IN_MAX_MS = 3600_000;

/*
 * A turn that never came (docs/cloud.md). An event that begins a turn and was delivered, so the
 * Claude session holds it, is owed an answer until the runner writes anything of a turn
 * (`design_runners.said_at`). While it is owed the sandbox does not sleep. It lapses, and the
 * thread says so and the event goes in again as a copy (once; a copy that lapses says to send
 * it again), when its runner says it is not working for two minutes, or says it is but has
 * written nothing for fifteen. Both are counted from the delivery or from when the runner that
 * holds it started, whichever is later, so a cold start or a long session's resume gets its own
 * time. Two minutes is many times what a runner takes to write a turn's first item after the
 * model's first token, which comes before it reports idle; fifteen is past the slowest first
 * output of a model on a long session, and past Claude Code's own ten-minute limit on a request.
 */
export const OWED_IDLE_MS = 2 * 60_000;
export const OWED_SILENT_MS = 15 * 60_000;
/**
 * A runner that says it is working and has written nothing of the turn for an hour is stuck:
 * it is restarted and the thread says so. The runner's own watchdog stops a silent turn after
 * twenty minutes and rewrites a long turn's item every few minutes, so this is for one that is
 * wedged.
 */
export const STALLED_MS = 60 * 60_000;

export type SweepStep =
  | "retire"
  | "stop"
  | "restart"
  | "lapse"
  | "stalled"
  | "sleep"
  | "cycle"
  | "extend"
  | "repair";

/**
 * Whether the design owes a turn: `wait` while the one it owes may still come (the sandbox stays
 * awake), `lapse` once it is past waiting for, null when it owes none.
 */
export function owing(row: SweptSandbox, now: number): "wait" | "lapse" | null {
  const newest = row.owed.at(-1);
  if (!newest) return null;
  const waited = now - Math.max(newest.deliveredAt.getTime(), row.runnerStartedAt?.getTime() ?? 0);
  const starting = row.agentState === "working" || row.agentState === "waking";
  if (waited >= OWED_SILENT_MS || (!starting && waited >= OWED_IDLE_MS)) return "lapse";
  return "wait";
}

/** Whether the runner says it is working but has written nothing of the turn for too long. */
function stalled(row: SweptSandbox, now: number): boolean {
  if (row.agentState !== "working") return false;
  const since = Math.max(row.saidAt?.getTime() ?? 0, row.runnerStartedAt?.getTime() ?? 0);
  return now - since >= STALLED_MS;
}

/** What the sweep does with one sandbox now, or null for nothing. */
export function stepFor(row: SweptSandbox, now: number, idleMs: number): SweepStep | null {
  const { sandbox } = row;
  if (row.designStatus === "settled") return "retire";
  if (sandbox.state === "awake") {
    // Nothing more may run on the credential its runner holds, or for an owner who left.
    if (!row.claudeUsable || !row.ownerMember) return "stop";
    const heard = Math.max(sandbox.awakeSince?.getTime() ?? 0, row.heardAt?.getTime() ?? 0);
    if (heard < now - DEAD_AFTER_MS) return "restart";
    const owes = owing(row, now);
    if (owes === "lapse") return "lapse";
    if (stalled(row, now)) return "stalled";
    // A turn owed is work, whatever the runner reports: never slept on.
    if (!owes && sandbox.lastActivityAt.getTime() < now - idleMs) return "sleep";
    if (sandbox.sessionStartedAt && sandbox.sessionStartedAt.getTime() < now - SESSION_CYCLE_MS) {
      return "cycle";
    }
    if (!sandbox.expiresAt || sandbox.expiresAt.getTime() < now + EXTEND_WITHIN_MS) {
      return "extend";
    }
    return null;
  }
  if (sandbox.state === "waking" || sandbox.state === "stopping") {
    if (sandbox.stateAt.getTime() < now - WAKING_LEASE_MS) return "repair";
  }
  return null;
}

/**
 * How long to extend a session by: `EXTEND_BY_MS`, clamped so its whole length stays a margin
 * inside Vercel's cap. Vercel caps the session's timeout from its start, so what counts is the
 * deadline it has now, not the time already run. Zero or less means do not extend.
 */
export function extendBy(sandbox: Pick<SandboxRow, "sessionStartedAt" | "expiresAt">): number {
  if (!sandbox.sessionStartedAt || !sandbox.expiresAt) return EXTEND_BY_MS;
  const length = sandbox.expiresAt.getTime() - sandbox.sessionStartedAt.getTime();
  return Math.min(EXTEND_BY_MS, MAX_SESSION_MS - length - EXTEND_MARGIN_MS);
}

export type SweepCounts = Record<SweepStep | "reconciled", number>;

export async function sweepSandboxes(deps: JobDeps): Promise<SweepCounts> {
  const now = deps.clock.now();
  const idleMs = deps.config.sandbox.idleSeconds * 1000;
  const counts: SweepCounts = {
    retire: 0,
    stop: 0,
    restart: 0,
    lapse: 0,
    stalled: 0,
    sleep: 0,
    cycle: 0,
    extend: 0,
    repair: 0,
    reconciled: 0,
  };
  const rows = await listSandboxesToSweep(deps.db, { now: new Date(now) });
  await Promise.all(
    rows.map(async (row) => {
      const step = stepFor(row, now, idleMs);
      if (!step) return;
      try {
        if (await STEPS[step](deps, row, now - idleMs)) counts[step]++;
      } catch (error) {
        deps.log.warn("sweep_failed", { designId: row.sandbox.designId, step, error });
        deps.analytics.exception(error, { sweep_step: step, design_id: row.sandbox.designId });
      }
    }),
  );
  if (new Date(now).getUTCMinutes() % RECONCILE_EVERY_MINUTES === 0) {
    try {
      counts.reconciled = await reconcile(deps);
    } catch (error) {
      deps.log.warn("sweep_failed", { step: "reconcile", error });
      deps.analytics.exception(error, { sweep_step: "reconcile" });
    }
  }
  return counts;
}

type Step = (deps: JobDeps, row: SweptSandbox, idleBefore: number) => Promise<boolean>;

const STEPS: Record<SweepStep, Step> = {
  retire: async (deps, { sandbox }) => {
    await retire(deps, sandbox.designId);
    return true;
  },

  stop: async (deps, row) => {
    const { designId } = row.sandbox;
    const why = row.ownerMember ? "claude_unusable" : "owner_left";
    const slept = await putToSleep(deps, row.sandbox, why);
    if (!row.ownerMember) {
      await showAgentWaiting(deps.db, { designId, waking: false, blocker: "claude_owner_left" });
    }
    return slept;
  },

  restart: async (deps, { sandbox }) => {
    const { db, log } = deps;
    const { designId } = sandbox;
    const restarts = await countSandboxRestart(db, designId);
    if (restarts > MAX_RESTARTS) {
      const failure = `Its runner stopped answering ${restarts} times in a row.`;
      if (!(await putToSleep(deps, sandbox, "failed", { failure }))) return false;
      await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
      log.error("runner_dead", { designId, restarts });
      return true;
    }
    // A runner that exited for good (a revoked token, a lost lease, a bad environment) comes
    // back only with a new start: shut down what is left, and wake it.
    log.warn("runner_dead", { designId, restarts });
    return putToSleep(deps, sandbox, "restart", { wake: "restart" });
  },

  lapse: async (deps, row) => {
    const { db, clock, log } = deps;
    const { sandbox } = row;
    const { designId } = sandbox;
    const now = clock.now();
    const lapsed = await lapseEvents(db, {
      designId,
      ids: row.owed.map((event) => event.id),
      now: new Date(now),
    });
    if (lapsed.length === 0) return false;
    const copies = lapsed.flatMap((event) => (event.copy ? [event.copy] : []));
    const newest = row.owed.at(-1)!;
    // Under the event's id, so a sweep that runs this twice says it once.
    await appendThreadItemOnce(db, {
      id: `ti_lapsed-${lapsed.at(-1)!.id}`,
      designId,
      kind: "notice",
      payload: {
        type: "error",
        code: "turn_failed",
        message: copies.length ? LAPSED_AGAIN : LAPSED_GIVE_UP,
      },
    });
    const starting = row.agentState === "working" || row.agentState === "waking";
    const fields = {
      designId,
      runnerId: row.runnerId,
      events: lapsed.map((event) => event.id),
      copies,
      agentState: row.agentState,
      deliveredMs: now - newest.deliveredAt.getTime(),
      runnerMs: row.runnerStartedAt ? now - row.runnerStartedAt.getTime() : null,
      saidMs: row.saidAt ? now - row.saidAt.getTime() : null,
      heardMs: row.heardAt ? now - row.heardAt.getTime() : null,
    };
    log.warn("turn_lapsed", fields);
    await captureAbout(deps, designId, "turn lapsed", {
      kinds: lapsed.map((event) => event.kind),
      sent_again: copies.length > 0,
      agent_state: row.agentState,
      waited_ms: fields.deliveredMs,
    });
    if (starting) {
      // It says it is working and has said nothing in all this time: its runner is started
      // again, and the copy is the next runner's.
      await putToSleep(deps, sandbox, "restart", { wake: "lapsed" });
      return true;
    }
    // An idle runner claims the copy at once; failing that, within the minute by itself.
    await pokeRunner(deps, sandbox);
    return true;
  },

  stalled: async (deps, row) => {
    const { db, clock, log } = deps;
    const { sandbox } = row;
    const { designId } = sandbox;
    const now = clock.now();
    await appendThreadItemOnce(db, {
      id: `ti_stalled-${row.runnerId ?? designId}`,
      designId,
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: STALLED_SAID },
    });
    log.warn("turn_stalled", {
      designId,
      runnerId: row.runnerId,
      saidMs: row.saidAt ? now - row.saidAt.getTime() : null,
      runnerMs: row.runnerStartedAt ? now - row.runnerStartedAt.getTime() : null,
    });
    await captureAbout(deps, designId, "turn stalled", {});
    return putToSleep(deps, sandbox, "restart", { wake: "stalled" });
  },

  sleep: (deps, { sandbox }, idleBefore) =>
    putToSleep(deps, sandbox, "idle", { idleBefore: new Date(idleBefore) }),

  // Before the session reaches Vercel's cap: a sleep, then the pending rule.
  cycle: (deps, { sandbox }) => putToSleep(deps, sandbox, "cycle"),

  extend: async (deps, { sandbox }) => {
    const { designId, sessionId } = sandbox;
    const by = extendBy(sandbox);
    if (by <= 0 || !sessionId) return false;
    const deadline = await deps.sandboxes.extend(
      { name: sandboxName(deps, designId), sessionId },
      by,
    );
    if (deadline !== null) {
      await setSandboxExpiry(deps.db, { designId, sessionId, expiresAt: new Date(deadline) });
      return true;
    }
    // Vercel already stopped the session: the row follows, and the pending rule wakes it.
    const asleep = await moveSandbox(deps.db, {
      designId,
      from: ["awake"],
      to: "asleep",
      now: new Date(deps.clock.now()),
      sessionId,
    });
    if (!asleep) return false;
    deps.log.warn("sandbox_expired", { designId, sessionId });
    const awakeMs = sandbox.awakeSince ? deps.clock.now() - sandbox.awakeSince.getTime() : 0;
    await captureSlept(deps, designId, "expired", awakeMs);
    await wakeIfPending(deps, designId);
    return true;
  },

  repair: async (deps, row) => {
    const { db, clock, sandboxes } = deps;
    const { sandbox } = row;
    const { designId } = sandbox;
    // (A settled design's row, a retire that died among them, is the retire step's.)
    const name = sandboxName(deps, designId);
    const seen = await sandboxes.status(name);
    if (seen?.status === "running" && seen.sessionId) {
      await sandboxes.stop({ name, sessionId: seen.sessionId });
    }
    // Only a move nobody has made progress on since the sweep looked.
    const asleep = await moveSandbox(db, {
      designId,
      from: ["waking", "stopping"],
      to: "asleep",
      now: new Date(clock.now()),
      stateBefore: new Date(sandbox.stateAt.getTime() + 1),
    });
    if (!asleep) return false;
    deps.log.warn("sandbox_repaired", { designId, was: sandbox.state, by: sandbox.wakingBy });
    await wakeIfPending(deps, designId);
    return true;
  },
};

/** What the thread says when an owed turn lapses and the event goes in again. */
export const LAPSED_AGAIN =
  "Claude was cut off before it answered this, so Ponzu is sending it again.";
/** What it says when the copy lapsed too. */
export const LAPSED_GIVE_UP = "Claude didn't get to this message. Send it again to try once more.";
export const STALLED_SAID =
  "Claude went quiet for an hour in the middle of this turn, so Ponzu restarted it. Send a message to pick it up again.";

/** Ask the runner to claim now. A runner that does not answer claims within the minute anyway. */
async function pokeRunner(deps: JobDeps, sandbox: SandboxRow): Promise<void> {
  try {
    const target = await runnerTarget(deps, sandbox);
    if (target) await deps.poke(target);
  } catch (error) {
    deps.log.info("poke_missed", { designId: sandbox.designId, error });
  }
}

/** An analytics event about the design's owner, under its workspace. Never fails the sweep. */
async function captureAbout<E extends "turn lapsed" | "turn stalled">(
  deps: JobDeps,
  designId: string,
  event: E,
  properties: Omit<ServerEvents[E], "design_id">,
): Promise<void> {
  const design = await getDesign(deps.db, designId).catch(() => null);
  if (!design) return;
  deps.analytics.capture(event, { design_id: designId, ...properties } as ServerEvents[E], {
    distinctId: design.ownerId,
    workspaceId: design.workspaceId,
  });
}

/**
 * This database's names at Vercel against its rows, at most `RECONCILE_ACTIONS` actions a run.
 * Answers how many it took.
 *
 *   design names   a row waking or stopping inside its lease is left alone, whatever its
 *                  session; a running sandbox is stopped, pinned to its own session, when its
 *                  row is missing, asleep, or awake on another session (`sandbox_leak`); a name
 *                  whose design was deleted is removed. A settled design's is retire's.
 *   sign-in names  removed once the sign-in is over or an hour old.
 */
export async function reconcile(deps: JobDeps): Promise<number> {
  const { scope } = deps.config.sandbox;
  const now = deps.clock.now();
  const listed = await deps.sandboxes.list(scopePrefix(scope));
  const named = listed.flatMap((info) => {
    const parsed = parseSandboxName(info.name);
    // Checked again here: another deployment's sandbox is never this one's to touch.
    return parsed && parsed.scope === scope ? [{ info, parsed }] : [];
  });
  const owners = await getSandboxOwners(deps.db, {
    designIds: named.filter((n) => n.parsed.kind === "design").map((n) => n.parsed.id),
    signInIds: named.filter((n) => n.parsed.kind === "signin").map((n) => n.parsed.id),
  });
  let actions = 0;
  for (const { info, parsed } of named) {
    if (actions >= RECONCILE_ACTIONS) break;
    const action =
      parsed.kind === "design"
        ? designAction(info, owners.designs.get(parsed.id)!, now)
        : signInAction(owners.signIns.get(parsed.id)!, now);
    if (!action) continue;
    try {
      if (action === "remove") {
        await deps.sandboxes.remove(info.name);
        deps.log.warn("sandbox_orphan_removed", { name: info.name, kind: parsed.kind });
      } else {
        await deps.sandboxes.stop({ name: info.name, sessionId: info.sessionId! });
        deps.log.warn("sandbox_leak", { name: info.name, sessionId: info.sessionId });
      }
      actions++;
    } catch (error) {
      deps.log.warn("reconcile_failed", { name: info.name, action, error });
    }
  }
  return actions;
}

function designAction(
  info: SandboxInfo,
  { exists, sandbox }: { exists: boolean; sandbox: SandboxRow | null },
  now: number,
): "remove" | "stop" | null {
  const held = sandbox && (sandbox.state === "waking" || sandbox.state === "stopping");
  if (held && sandbox.stateAt.getTime() >= now - WAKING_LEASE_MS) return null;
  // Its design was deleted; its id never comes back.
  if (!exists) return "remove";
  if (info.status !== "running" || !info.sessionId) return null;
  if (!sandbox || sandbox.state === "asleep") return "stop";
  if (sandbox.state === "awake" && sandbox.sessionId !== info.sessionId) return "stop";
  return null;
}

function signInAction(
  state: { exists: boolean; consumedAt: Date | null; createdAt: Date | null },
  now: number,
): "remove" | null {
  if (!state.exists || state.consumedAt) return "remove";
  if (state.createdAt && state.createdAt.getTime() < now - SIGN_IN_MAX_MS) return "remove";
  return null;
}

import {
  appendThreadItemOnce,
  countSandboxRestart,
  getDesign,
  hasHeldEvents,
  isSandboxKnown,
  lapseEvents,
  listSandboxesToSweep,
  moveSandbox,
  revokeRunnerTokens,
  type SweptSandbox,
  setSandboxAutoStop,
  showAgentWaiting,
  WAKING_LEASE_MS,
} from "@ponzu/db";
import type { ServerEvents } from "../analytics/events.ts";
import type { JobDeps } from "../jobs/run.ts";
import { AUTO_STOP_SECONDS, designSandboxes, sandboxLabels } from "./orchestrate.ts";
import { runnerAddress, stopSandbox } from "./quiesce.ts";
import { destroySandboxes, retireSandboxes } from "./retire.ts";
import { startWake } from "./wake.ts";

/*
 * The minute's look over every sandbox that costs something or is moving (docs/cloud.md, "The
 * sandbox"). boat has no idle detection, so this is what puts sandboxes to sleep: with an
 * explicit stop, which keeps the machine warm for about ten minutes, where the provider's own
 * auto-stop (kept well ahead while awake) would not. It also brings back runners that went
 * quiet; destroys the sandboxes of settled designs, the ones whose environment carries a Claude
 * credential that was disconnected or whose owner left, and the ones nothing knows; and repairs
 * rows a crashed function left halfway through a move.
 *
 * Each sandbox's step is a move that holds to the state it moves from, so two sweeps at once,
 * or a sweep and a wake, cannot both act on it. Only this database's sandboxes are looked at
 * (the `scope` label): every deployment shares the provider account.
 */

/** A runner unheard from for this long (the heartbeat is every 30 s) is taken as dead. */
export const DEAD_AFTER_MS = 90_000;
/** The provider's auto-stop is moved out once it is closer than this. */
const EXTEND_WITHIN_MS = 10 * 60_000;
/** Restarts in a row of a runner that never answers before the sandbox is failed. */
const MAX_RESTARTS = 3;

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
 * output of a model on a long session (a minute or so of reading the context, then thinking at
 * the most effort), and past Claude Code's own ten-minute limit on a request.
 */
export const OWED_IDLE_MS = 2 * 60_000;
export const OWED_SILENT_MS = 15 * 60_000;
/**
 * A runner that says it is working and has written nothing of the turn for an hour is stuck:
 * its sandbox is started again cold and the thread says so. The runner's own watchdog stops a
 * silent turn after twenty minutes and rewrites a long turn's item every few minutes, so this
 * is for a runner older than that, or one that is wedged.
 */
export const STALLED_MS = 60 * 60_000;

export type SweepStep =
  | "retire"
  | "sleep"
  | "stop"
  | "restart"
  | "repair"
  | "extend"
  | "lapse"
  | "stalled";

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
  if (row.designStatus === "settled" || !row.claudeHeld) return "retire";
  if (sandbox.state === "awake") {
    // Its owner disconnected Claude: nothing more may run on the credential it holds.
    if (!row.claudeUsable) return "stop";
    const heard = Math.max(sandbox.awakeSince?.getTime() ?? 0, row.heardAt?.getTime() ?? 0);
    if (heard < now - DEAD_AFTER_MS) return "restart";
    const owes = owing(row, now);
    if (owes === "lapse") return "lapse";
    if (stalled(row, now)) return "stalled";
    // A turn owed is work, whatever the runner reports: never slept on.
    if (!owes && sandbox.lastActivityAt.getTime() < now - idleMs) return "sleep";
    if (!sandbox.autoStopAt || sandbox.autoStopAt.getTime() < now + EXTEND_WITHIN_MS) {
      return "extend";
    }
    return null;
  }
  if (sandbox.state === "waking" || sandbox.state === "stopping") {
    if (sandbox.stateAt.getTime() < now - WAKING_LEASE_MS) return "repair";
  }
  return null;
}

export type SweepCounts = Record<SweepStep | "orphaned", number>;

export async function sweepSandboxes(deps: JobDeps): Promise<SweepCounts> {
  const now = deps.clock.now();
  const idleMs = deps.config.sandbox.idleSeconds * 1000;
  const counts: SweepCounts = {
    retire: 0,
    sleep: 0,
    stop: 0,
    restart: 0,
    repair: 0,
    extend: 0,
    lapse: 0,
    stalled: 0,
    orphaned: 0,
  };
  const rows = await listSandboxesToSweep(deps.db, { now: new Date(now) });
  await Promise.all(
    rows.map(async (row) => {
      const step = stepFor(row, now, idleMs);
      if (!step) return;
      try {
        if (await STEPS[step](deps, row, now - idleMs)) counts[step]++;
      } catch (error) {
        deps.log.warn("sweep_failed", { sandboxId: row.sandbox.id, step, error });
        deps.analytics.exception(error, { sweep_step: step, design_id: row.sandbox.designId });
      }
    }),
  );
  try {
    counts.orphaned = await destroyOrphans(deps);
  } catch (error) {
    deps.log.warn("sweep_failed", { step: "orphaned", error });
    deps.analytics.exception(error, { sweep_step: "orphaned" });
  }
  return counts;
}

type Step = (deps: JobDeps, row: SweptSandbox, idleBefore: number) => Promise<boolean>;

const STEPS: Record<SweepStep, Step> = {
  retire: async (deps, row) => {
    const { designId } = row.sandbox;
    await destroySandboxes(deps, await retireSandboxes(deps, designId));
    if (row.designStatus !== "settled" && !row.ownerMember) {
      await showAgentWaiting(deps.db, { designId, waking: false, blocker: "claude_owner_left" });
    }
    return true;
  },

  sleep: (deps, { sandbox }, idleBefore) => putToSleep(deps, sandbox, new Date(idleBefore)),

  stop: (deps, { sandbox }) => putToSleep(deps, sandbox),

  restart: async (deps, { sandbox }) => {
    const { db, clock, log } = deps;
    const restarts = await countSandboxRestart(db, sandbox.id);
    if (restarts > MAX_RESTARTS) {
      const failed = await moveSandbox(db, {
        id: sandbox.id,
        from: ["awake"],
        to: "failed",
        now: new Date(clock.now()),
        changes: { failure: `Its runner stopped answering ${restarts} times in a row.` },
      });
      if (!failed) return false;
      await deps.sandbox.stop(sandbox.providerId!);
      await showAgentWaiting(db, {
        designId: sandbox.designId,
        waking: false,
        blocker: "sandbox_failed",
      });
      log.error("runner_dead", { designId: sandbox.designId, sandboxId: sandbox.id, restarts });
      return true;
    }
    // A runner that exited for good (a revoked token, a lost lease, a bad environment) comes
    // back only with a new start of the sandbox on a new environment: stop it, forget the
    // environment it had, and wake it.
    log.warn("runner_dead", { designId: sandbox.designId, sandboxId: sandbox.id, restarts });
    if (!(await putToSleep(deps, sandbox, undefined, { claudeCredential: null }))) return false;
    await startWake(deps, sandbox.designId, "restart");
    return true;
  },

  repair: async (deps, row) => {
    const { db, clock, config } = deps;
    const { sandbox } = row;
    const now = new Date(clock.now());
    const moving = ["waking", "stopping"] as const;
    // Only a move nobody has made progress on since the sweep looked.
    const stateBefore = new Date(sandbox.stateAt.getTime() + 1);
    if (!sandbox.providerId) {
      // A create that never got as far as the provider, or whose answer never came back. What
      // it may have made carries the row's labels and an environment nothing recorded, the
      // owner's Claude credential in it: destroy that, and the runner tokens issued for it.
      const failed = await moveSandbox(db, {
        id: sandbox.id,
        from: moving,
        to: "failed",
        now,
        stateBefore,
        changes: { failure: "Its wake was cut off." },
      });
      if (!failed) return false;
      const made = await deps.sandbox.list({
        labels: sandboxLabels(config.sandbox.scope, sandbox.designId, sandbox.generation),
      });
      await revokeRunnerTokens(db, sandbox.designId);
      // One whose destroy fails is no row's now: the orphan sweep finds it next.
      await destroySandboxes(
        deps,
        made.filter((found) => found.state !== "gone").map((found) => found.id),
      );
    } else {
      const seen = await deps.sandbox.get(sandbox.providerId);
      if (seen.state === "starting" || seen.state === "stopping") return false;
      const moved = await moveSandbox(db, {
        id: sandbox.id,
        from: moving,
        to: seen.state,
        now,
        stateBefore,
        changes:
          seen.state === "gone"
            ? { failure: seen.reason ?? "The provider lost it." }
            : seen.state === "awake"
              ? { autoStopAt: seen.autoStopAt ? new Date(seen.autoStopAt) : null }
              : {},
      });
      if (!moved) return false;
      if (seen.state === "awake") return true;
    }
    if (row.pending) await startWake(deps, sandbox.designId, "repair");
    return true;
  },

  extend: async (deps, { sandbox }) => {
    await deps.sandbox.extend(sandbox.providerId!, AUTO_STOP_SECONDS);
    await setSandboxAutoStop(deps.db, {
      id: sandbox.id,
      autoStopAt: new Date(deps.clock.now() + AUTO_STOP_SECONDS * 1000),
    });
    return true;
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
      sandboxId: sandbox.id,
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
      // It says it is working and has said nothing in all this time: a warm resume would thaw
      // the same stuck process, so it starts cold, and the copy is the next runner's.
      if (!(await putToSleep(deps, sandbox, undefined, { claudeCredential: null }))) return true;
      await startWake(deps, designId, "lapsed");
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
      id: `ti_stalled-${row.runnerId ?? sandbox.id}`,
      designId,
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: STALLED_SAID },
    });
    log.warn("turn_stalled", {
      designId,
      sandboxId: sandbox.id,
      runnerId: row.runnerId,
      saidMs: row.saidAt ? now - row.saidAt.getTime() : null,
      runnerMs: row.runnerStartedAt ? now - row.runnerStartedAt.getTime() : null,
    });
    await captureAbout(deps, designId, "turn stalled", {});
    if (!(await putToSleep(deps, sandbox, undefined, { claudeCredential: null }))) return false;
    await startWake(deps, designId, "stalled");
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
async function pokeRunner(deps: JobDeps, sandbox: SweptSandbox["sandbox"]): Promise<void> {
  try {
    const address = await runnerAddress(deps, sandbox);
    if (address) await deps.poke(address);
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
 * Put an awake sandbox to sleep with an explicit stop, once its runner is ready for it or has
 * had its time (quiesce.ts). With `idleBefore`, only if nobody has kept it awake since. False
 * when it was not this call that stopped it.
 */
async function putToSleep(
  deps: JobDeps,
  sandbox: SweptSandbox["sandbox"],
  idleBefore?: Date,
  changes?: { claudeCredential: null },
): Promise<boolean> {
  const { db, clock } = deps;
  const stopping = await moveSandbox(db, {
    id: sandbox.id,
    from: ["awake"],
    to: "stopping",
    now: new Date(clock.now()),
    ...(idleBefore ? { idleBefore } : {}),
    ...(changes ? { changes } : {}),
  });
  if (!stopping) return false;
  // A runner that is being restarted for going quiet has nothing to say.
  await stopSandbox(deps, stopping, { quiesce: !changes });
  // The stop is under way; a wake that comes now waits it out.
  await moveSandbox(db, {
    id: sandbox.id,
    from: ["stopping"],
    to: "asleep",
    now: new Date(clock.now()),
  });
  // A claim the runner had out as it got ready brought events it held back for the wake
  // (docs/cloud.md, "Getting ready to sleep"); asleep, nothing would wake the design for them.
  if (idleBefore && (await hasHeldEvents(db, sandbox.designId))) {
    await startWake(deps, sandbox.designId, "held");
  }
  return true;
}

/**
 * Destroy the design sandboxes at the provider that no design's row knows: a design deleted
 * while its destroy failed, or a sandbox a lost create made. Answers how many.
 */
async function destroyOrphans(deps: JobDeps): Promise<number> {
  const { scope } = deps.config.sandbox;
  const listed = await deps.sandbox.list({ labels: designSandboxes(scope) });
  const now = new Date(deps.clock.now());
  const orphans: string[] = [];
  await Promise.all(
    listed.map(async (sandbox) => {
      const designId = sandbox.labels.design;
      // Checked again here: another deployment's sandbox is never this sweep's to destroy.
      if (!designId || sandbox.state === "gone" || sandbox.labels.scope !== scope) return;
      if (await isSandboxKnown(deps.db, { designId, providerId: sandbox.id, now })) return;
      orphans.push(sandbox.id);
    }),
  );
  if (orphans.length > 0) deps.log.warn("sandbox_orphaned", { count: orphans.length });
  await destroySandboxes(deps, orphans);
  return orphans.length;
}

import {
  countSandboxRestart,
  isSandboxKnown,
  listSandboxesToSweep,
  moveSandbox,
  type SweptSandbox,
  setSandboxAutoStop,
  showAgentWaiting,
} from "@ponzu/db";
import type { JobDeps } from "../jobs/run.ts";
import { AUTO_STOP_SECONDS, DESIGN_SANDBOX } from "./orchestrate.ts";
import { destroySandboxes, retireSandboxes } from "./retire.ts";
import { startWake } from "./wake.ts";

/*
 * The minute's look over every sandbox that costs something or is moving (docs/cloud.md, "The
 * sandbox"). boat has no idle detection, so this is what puts sandboxes to sleep: with an
 * explicit stop, which keeps the machine warm for about ten minutes, where the provider's own
 * auto-stop (kept well ahead while awake) would not. It also brings back runners that went
 * quiet, destroys the sandboxes of settled designs and the ones nothing knows, and repairs rows
 * a crashed function left halfway through a move.
 *
 * Each sandbox's step is a move that holds to the state it moves from, so two sweeps at once,
 * or a sweep and a wake, cannot both act on it.
 */

/** A runner unheard from for this long (the heartbeat is every 30 s) is taken as dead. */
export const DEAD_AFTER_MS = 90_000;
/**
 * A move left in `waking` or `stopping` this long was abandoned by its function. Longer than a
 * job's lock, so a wake still being tried is never taken for one.
 */
const STUCK_AFTER_MS = 6 * 60_000;
/** The provider's auto-stop is moved out once it is closer than this. */
const EXTEND_WITHIN_MS = 10 * 60_000;
/** Restarts in a row of a runner that never answers before the sandbox is failed. */
const MAX_RESTARTS = 3;

export type SweepStep = "retire" | "sleep" | "stop" | "restart" | "repair" | "extend";

/** What the sweep does with one sandbox now, or null for nothing. */
export function stepFor(row: SweptSandbox, now: number, idleMs: number): SweepStep | null {
  const { sandbox } = row;
  if (row.designStatus === "settled") return "retire";
  if (sandbox.state === "awake") {
    // Its owner disconnected Claude: nothing more may run on the credential it holds.
    if (!row.claudeUsable) return "stop";
    const heard = Math.max(sandbox.awakeSince?.getTime() ?? 0, row.heardAt?.getTime() ?? 0);
    if (heard < now - DEAD_AFTER_MS) return "restart";
    if (sandbox.lastActivityAt.getTime() < now - idleMs) return "sleep";
    if (!sandbox.autoStopAt || sandbox.autoStopAt.getTime() < now + EXTEND_WITHIN_MS) {
      return "extend";
    }
    return null;
  }
  if (sandbox.state === "waking" || sandbox.state === "stopping") {
    if (sandbox.stateAt.getTime() < now - STUCK_AFTER_MS) return "repair";
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
      }
    }),
  );
  try {
    counts.orphaned = await destroyOrphans(deps);
  } catch (error) {
    deps.log.warn("sweep_failed", { step: "orphaned", error });
  }
  return counts;
}

type Step = (deps: JobDeps, row: SweptSandbox, idleBefore: number) => Promise<boolean>;

const STEPS: Record<SweepStep, Step> = {
  retire: async (deps, { sandbox }) => {
    await destroySandboxes(deps, await retireSandboxes(deps, sandbox.designId));
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
    const { db, clock } = deps;
    const { sandbox } = row;
    const now = new Date(clock.now());
    const moving = ["waking", "stopping"] as const;
    if (!sandbox.providerId) {
      // A create that never got as far as the provider, or never heard back.
      await moveSandbox(db, {
        id: sandbox.id,
        from: moving,
        to: "failed",
        now,
        changes: { failure: "Its wake was cut off." },
      });
    } else {
      const seen = await deps.sandbox.get(sandbox.providerId);
      if (seen.state === "starting" || seen.state === "stopping") return false;
      await moveSandbox(db, {
        id: sandbox.id,
        from: moving,
        to: seen.state,
        now,
        changes:
          seen.state === "gone"
            ? { failure: seen.reason ?? "The provider lost it." }
            : seen.state === "awake"
              ? { autoStopAt: seen.autoStopAt ? new Date(seen.autoStopAt) : null }
              : {},
      });
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
};

/**
 * Put an awake sandbox to sleep with an explicit stop. With `idleBefore`, only if nobody has
 * kept it awake since. False when it was not this call that stopped it.
 */
export async function putToSleep(
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
  await deps.sandbox.stop(sandbox.providerId!);
  // The stop is under way; a wake that comes now waits it out.
  await moveSandbox(db, {
    id: sandbox.id,
    from: ["stopping"],
    to: "asleep",
    now: new Date(clock.now()),
  });
  return true;
}

/**
 * Destroy the design sandboxes at the provider that no design's row knows: a design deleted
 * while its destroy failed, or a sandbox a lost create made. Answers how many.
 */
async function destroyOrphans(deps: JobDeps): Promise<number> {
  const listed = await deps.sandbox.list({ labels: DESIGN_SANDBOX });
  const orphans: string[] = [];
  await Promise.all(
    listed.map(async (sandbox) => {
      const designId = sandbox.labels.design;
      if (!designId || sandbox.state === "gone") return;
      if (await isSandboxKnown(deps.db, { designId, providerId: sandbox.id })) return;
      orphans.push(sandbox.id);
    }),
  );
  if (orphans.length > 0) deps.log.warn("sandbox_orphaned", { count: orphans.length });
  await destroySandboxes(deps, orphans);
  return orphans.length;
}

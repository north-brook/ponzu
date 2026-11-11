import { enqueueJob, getAwakeSandboxAddress } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/*
 * The one door from what people do to a design's sandbox (docs/cloud.md, "The sandbox" and
 * "Events"). Every route that adds to a design's feed, and every op a person commits, calls
 * `requestWake` once it has written, and nothing else reaches for the sandbox:
 *
 *   POST /v1/designs/:id/messages                    "message"
 *   POST /v1/designs/:id/questions/:id/answer        "answer"
 *   POST /v1/designs/:id/stop                        "stop"
 *   a person's ops (commitPost), undo and redo       "comment" when the ops left a comment for
 *                                                    the agent, else "edit"
 *
 * FOR NOW it only records the intent, and pokes a runner that is already awake. The sandbox
 * orchestrator replaces this body: it keeps the signature and the call sites, and runs the
 * `WAKE_JOB` this records (create, resume, credits) where `runWakeJob` now does nothing.
 */

export type WakeReason = "message" | "answer" | "comment" | "stop" | "edit";

/** What waking takes. A caller of `requestWake` takes these with its own (`CommitDeps`). */
export type WakeDeps = Pick<Deps, "db" | "clock" | "vault" | "poke" | "background" | "log">;

/** The job that wakes a design's sandbox. One waits per design: its key is the design's id. */
export const WAKE_JOB = "sandbox.wake";

/**
 * What wakes a sleeping sandbox: a message, an answer or a comment (priority `now` or `next`).
 * A person's edit (`later`) does not, and neither does a stop: a sleeping sandbox is running
 * nothing to stop, and the stop is in the feed for when it next wakes.
 */
const WAKES: Record<WakeReason, boolean> = {
  message: true,
  answer: true,
  comment: true,
  stop: false,
  edit: false,
};

/**
 * Something happened to `designId` that its runner should hear of: record a wake when the
 * reason calls for one, and poke the runner when its sandbox is awake. Call it after the event
 * or op is written.
 *
 * It never fails: what the caller wrote is written, and a request that answered 5xx for it
 * would be sent again and write it twice. A wake it could not record is logged
 * (`wake_failed`), and the event waits in the feed until the sandbox next wakes. The poke is
 * not retried: an awake runner claims once a minute by itself.
 */
export async function requestWake(
  deps: WakeDeps,
  designId: string,
  reason: WakeReason,
): Promise<void> {
  try {
    await wake(deps, designId, reason);
  } catch (error) {
    deps.log.error("wake_failed", { designId, reason, error });
  }
}

async function wake(deps: WakeDeps, designId: string, reason: WakeReason): Promise<void> {
  const [, sandbox] = await Promise.all([
    WAKES[reason]
      ? // Null when a wake is already waiting for the design: that one will do.
        enqueueJob(deps.db, {
          kind: WAKE_JOB,
          key: designId,
          payload: { designId, reason },
          runAt: new Date(deps.clock.now()),
        })
      : null,
    getAwakeSandboxAddress(deps.db, designId),
  ]);
  if (!sandbox) return;
  deps.background(
    "poke",
    (async () => {
      const token = sandbox.encryptedAddressToken
        ? await deps.vault.open(sandbox.encryptedAddressToken, {
            column: "sandboxes.encrypted_address_token",
            row: sandbox.sandboxId,
          })
        : null;
      await deps.poke({ url: sandbox.address, token });
    })(),
  );
}

/**
 * Runs a recorded wake. Nothing creates or resumes sandboxes yet, so there is nothing to do:
 * the orchestrator replaces this. It is a handler so the cron completes these jobs rather than
 * failing them over and over.
 */
export async function runWakeJob(): Promise<void> {}

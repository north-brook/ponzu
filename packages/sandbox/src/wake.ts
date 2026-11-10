import { type Clock, poll } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import type { Resumed, ResumeOptions, Sandbox, Wake, WakeOptions } from "./provider.ts";

const WAKE_TIMEOUT_MS = 90_000;

/** What `ensureAwake` needs of a provider. Each call is told how long it may take, and must not take longer. */
export interface Waking {
  get(id: string, timeoutMs: number): Promise<Sandbox>;
  resume(id: string, options: ResumeOptions, timeoutMs: number): Promise<Resumed>;
  /**
   * Runs a command in the sandbox, for a provider that can report a machine awake a moment
   * before it takes one. `not_running` means not yet.
   */
  probe?(id: string, timeoutMs: number): Promise<void>;
}

/**
 * `ensureAwake` for any provider: look, resume if it sleeps, and keep looking until it is awake
 * and, after a start, has run a command. `timeoutMs` is a deadline for all of it.
 *
 * It resumes at most once. A resume the provider refuses as `busy` did nothing, so it is sent
 * again when the provider says to; any other refusal ends the wake. A resume that was accepted
 * and seems to have had no effect is waited out rather than repeated, since every cold start
 * counts against the account's start limits.
 */
export async function ensureAwake(
  provider: Waking,
  clock: Clock,
  id: string,
  options: WakeOptions = {},
): Promise<Wake> {
  const { timeoutMs = WAKE_TIMEOUT_MS, ...resume } = options;
  const started = clock.now();
  let start: Wake["start"] = "none";
  let resumed = false;
  let resumeNotBefore = started;

  const sandbox = await poll(clock, timeoutMs, `sandbox ${id} to wake`, async (left) => {
    let seen = await provider.get(id, left());
    if (seen.state === "gone") throw new SandboxError("not_found", `no sandbox ${id}`);

    if (resumed) {
      if (seen.state === "asleep" && seen.reason) {
        throw new SandboxError("unavailable", `sandbox ${id} did not start: ${seen.reason}`);
      }
    } else if (seen.state === "asleep") {
      if (clock.now() < resumeNotBefore) return undefined;
      try {
        const result = await provider.resume(id, resume, left());
        resumed = true;
        start = result.coldStart ? "cold" : "warm";
        seen = result.sandbox;
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === "busy")) throw error;
        // A stop can hold the machine for a moment after the sandbox reads asleep, and someone
        // else's resume can have got in first. Keep looking, and ask again when told to.
        const wait = (error.retryAfterSeconds ?? 0) * 1000;
        if (wait >= left()) {
          throw new SandboxError(
            "unavailable",
            `gave up waiting for sandbox ${id} to wake: it is busy for longer than there is time left`,
            { cause: error },
          );
        }
        resumeNotBefore = clock.now() + wait;
        return undefined;
      }
    } else if (seen.state !== "stopping") {
      // Awake already, or someone else is starting it.
      if (resume.env) {
        throw new SandboxError(
          "conflict",
          `sandbox ${id} is ${seen.state}, so its environment was not replaced; stop it first`,
        );
      }
      // A warm start is over before it can be seen, so one caught under way is a boot.
      if (seen.state === "starting") start = "cold";
    }

    if (seen.state !== "awake") return undefined;
    if (start !== "none" && provider.probe) {
      try {
        await provider.probe(id, left());
      } catch (error) {
        if (error instanceof SandboxError && error.code === "not_running") return undefined;
        throw error;
      }
    }
    return seen;
  });

  return { sandbox, start, resumed, ms: clock.now() - started };
}

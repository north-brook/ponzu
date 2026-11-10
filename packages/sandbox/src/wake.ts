import { type Clock, poll } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import type { Sandbox, SandboxProvider, Wake, WakeOptions } from "./provider.ts";

const WAKE_TIMEOUT_MS = 90_000;

/**
 * `ensureAwake` for any provider, from `get` and `resume`: look, resume if it sleeps, and keep
 * looking until it is awake. After a start, `accepting` then confirms a command runs, because
 * a provider can report a machine ready a moment before it is.
 *
 * It resumes at most once. A resume that seems to have had no effect is waited out rather than
 * repeated, since every cold start counts against the account's start limits.
 */
export async function ensureAwake(
  provider: Pick<SandboxProvider, "get" | "resume">,
  clock: Clock,
  id: string,
  options: WakeOptions = {},
  accepting: (id: string) => Promise<void> = async () => {},
): Promise<Wake> {
  const { timeoutMs = WAKE_TIMEOUT_MS, ...resume } = options;
  const started = clock.now();
  let start: Wake["start"] = "none";
  let resumed = false;

  const sandbox = await poll(clock, timeoutMs, `sandbox ${id} to wake`, async () => {
    let seen: Sandbox = await provider.get(id);
    if (seen.state === "gone") throw new SandboxError("not_found", `no sandbox ${id}`);
    if (seen.state === "asleep" && !resumed) {
      try {
        const result = await provider.resume(id, resume);
        resumed = true;
        start = result.coldStart ? "cold" : "warm";
        seen = result.sandbox;
      } catch (error) {
        // A stop can still hold the machine for a moment after the sandbox reads as asleep.
        if (!(error instanceof SandboxError && error.code === "conflict")) throw error;
      }
    } else if (seen.state === "starting" && !resumed) {
      // Someone else started it. A warm resume is over before it can be seen, so this is a boot.
      start = "cold";
    }
    return seen.state === "awake" ? seen : undefined;
  });

  if (start !== "none") await accepting(id);
  return { sandbox, start, ms: clock.now() - started };
}

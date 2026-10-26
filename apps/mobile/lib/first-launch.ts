/**
 * A store build carries the JavaScript of the release that last changed
 * native code; every release since reached installed phones over the air
 * (apps/mobile/.eas/workflows/production.yml). So a phone still running the
 * bundle it was installed with asks for the current release behind the
 * splash before showing anything, and restarts into it: a new install, or
 * the first launch after a new build from TestFlight, starts on current
 * code. Once any update has been applied the phone runs a downloaded bundle
 * and launches straight in. Kept free of native modules so it can be tested.
 */

/** How long the splash waits for the current release before going on. */
export const FIRST_LAUNCH_WAIT_MS = 6000;

export interface FirstLaunchUpdates {
  check: () => Promise<{ isAvailable: boolean }>;
  /** Downloads the update found; whether it is new to this phone. */
  fetch: () => Promise<{ isNew: boolean }>;
  /** Restarts into the downloaded update; nothing runs after it resolves. */
  reload: () => Promise<void>;
}

export type FirstLaunchOutcome =
  /** Running a downloaded update already, or updates are off. */
  | "current"
  /** The embedded bundle is the newest there is. */
  | "latest"
  /** Restarting into the newer release. */
  | "restarting"
  /** No answer in time, or the check failed: going on with the embedded one. */
  | "timed_out"
  | "failed";

/**
 * Brings a phone running its embedded bundle onto the current release,
 * waiting at most `waitMs` to find and download it. A download that
 * finishes after the wait is kept, and expo-updates launches it next time.
 */
export async function firstLaunch(
  at: { embedded: boolean; enabled: boolean },
  updates: FirstLaunchUpdates,
  waitMs = FIRST_LAUNCH_WAIT_MS,
): Promise<FirstLaunchOutcome> {
  if (!(at.enabled && at.embedded)) return "current";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), waitMs);
  });
  const download = (async () => {
    const check = await updates.check();
    if (!check.isAvailable) return "latest" as const;
    const fetched = await updates.fetch();
    return fetched.isNew ? ("downloaded" as const) : ("latest" as const);
  })().catch(() => "failed" as const);
  const outcome = await Promise.race([download, timeout]);
  clearTimeout(timer);
  if (outcome !== "downloaded") return outcome;
  try {
    await updates.reload();
    return "restarting";
  } catch {
    return "failed";
  }
}

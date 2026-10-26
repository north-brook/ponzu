import {
  checkForUpdateAsync,
  fetchUpdateAsync,
  isEmbeddedLaunch,
  isEnabled,
  reloadAsync,
} from "expo-updates";
import { useEffect, useState } from "react";
import { type FirstLaunchOutcome, firstLaunch, RESTART_WAIT_MS } from "./first-launch";
import { brand } from "./tokens";

// Started on import, beside the splash's hold, so the wait overlaps the
// rest of the launch rather than following it.
const outcome: Promise<FirstLaunchOutcome> = firstLaunch(
  { embedded: isEmbeddedLaunch, enabled: isEnabled },
  {
    check: checkForUpdateAsync,
    fetch: fetchUpdateAsync,
    // The restart's own screen in the splash's yuzu, so it doesn't flash
    // white between the splash and the launch screen.
    reload: () =>
      reloadAsync({
        reloadScreenOptions: { backgroundColor: brand.yuzu, spinner: { enabled: false } },
      }),
  },
);

/**
 * Whether the first launch of a store build has finished bringing itself
 * onto the current release (see `first-launch`). The splash stays up until
 * it has; on any later launch it is ready at once.
 */
export function useFirstLaunch(): boolean {
  const [ready, setReady] = useState(!(isEnabled && isEmbeddedLaunch));
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    outcome.then((result) => {
      if (!mounted) return;
      // A restart is under way: keep the splash up until it lands.
      if (result === "restarting") timer = setTimeout(() => setReady(true), RESTART_WAIT_MS);
      else setReady(true);
    });
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, []);
  return ready;
}

import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { devForget } from "../lib/macs";
import { reach, reachAll } from "../lib/reach";

/**
 * Development only: put the app in a state to look at it, then start again
 * from the launch screen. `ponzu://dev?forget=all` is a first launch;
 * `forget=dev` drops the branch server, leaving the tailnet Macs it named;
 * `forget=<id>,<id>` drops those. Release builds go straight to launch.
 */
export default function Dev() {
  const { forget } = useLocalSearchParams<{ forget?: string }>();
  useEffect(() => {
    (async () => {
      if (__DEV__) {
        // Let a pass already running finish, then ask again from scratch.
        await reachAll();
        if (forget) await devForget(forget);
        reach.set({});
      }
      if (router.canDismiss()) router.dismissAll();
      router.replace("/");
    })();
  }, [forget]);
  return null;
}

import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { devForget, devSeed, macs } from "../lib/macs";
import { LAUNCH } from "../lib/mark";
import { reach } from "../lib/reach";
import { Slice } from "../lib/slice";

/**
 * Development only: put the app in a state to look at it, then start again
 * from the launch screen. `ponzu://dev?forget=all` is a first launch;
 * `forget=dev` drops the branch server, leaving the tailnet Macs it named;
 * `forget=<id>,<id>` drops those; `seed=asleep|waking` adds Macs that
 * don't answer (see devSeed). Release builds go straight to launch.
 *
 * It doesn't wait for a pass over the Macs that's already running (a wake
 * knock alone takes 12s): forgotten Macs stay forgotten whatever that pass
 * hears. For the moment it's up, it looks like the launch screen.
 */
export default function Dev() {
  const { forget, seed } = useLocalSearchParams<{ forget?: string; seed?: string }>();
  useEffect(() => {
    (async () => {
      if (__DEV__) {
        if (forget) await devForget(forget);
        if (seed) await devSeed(seed);
        // Forgotten Macs leave with their reach; the launch screen asks the rest again.
        const kept = new Set(macs.get().map((m) => m.id));
        reach.set((all) => Object.fromEntries(Object.entries(all).filter(([id]) => kept.has(id))));
      }
      if (router.canDismiss()) router.dismissAll();
      router.replace("/");
    })();
  }, [forget, seed]);
  return (
    <View
      testID="dev"
      className="flex-1 items-center justify-center bg-yuzu"
      style={{ paddingTop: LAUNCH.top, paddingBottom: LAUNCH.bottom, gap: LAUNCH.gap }}
    >
      <Slice size={LAUNCH.mark} bloom="loop" />
    </View>
  );
}

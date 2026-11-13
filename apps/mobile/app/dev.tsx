import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { backend } from "../lib/cloud/backend";
import { LAUNCH } from "../lib/mark";
import { Slice } from "../lib/slice";
import { brand } from "../lib/tokens";

/**
 * The fake backend only (PONZU_BACKEND=fake): `ponzu-dev://dev?seed=<scenario>` puts the app in
 * a state to look at or test (lib/cloud/backend.fake.ts names them: signed-out, signed-in,
 * empty, github-reauth, too-old, setup-where, setup-claude, canvases, chat, needs-you,
 * pull-request, pings, search, filter), then starts again from the launch screen; with `relaunch=1`, the next
 * launch is put in it too. A real build has no
 * way in: lib/links.ts sends its dev links to the launch screen, and this does nothing there.
 */
export default function Dev() {
  const { seed, relaunch } = useLocalSearchParams<{ seed?: string; relaunch?: string }>();
  useEffect(() => {
    if (backend.kind === "fake" && seed) {
      backend.seed?.(seed);
      // Seeded again at the next launch too: a flow that ends the app opens it from a ping.
      if (relaunch === "1") void backend.seedNextLaunch?.(seed);
    }
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
  }, [seed]);
  return (
    <View
      testID="dev"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: brand.yuzu,
        paddingTop: LAUNCH.top,
        paddingBottom: LAUNCH.bottom,
        gap: LAUNCH.gap,
      }}
    >
      <Slice size={LAUNCH.mark} bloom="loop" />
    </View>
  );
}

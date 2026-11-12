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
 * empty, github-reauth, too-old), then starts again from the launch screen. A real build has no
 * way in: lib/links.ts sends its dev links to the launch screen, and this does nothing there.
 */
export default function Dev() {
  const { seed } = useLocalSearchParams<{ seed?: string }>();
  useEffect(() => {
    if (backend.kind === "fake" && seed) backend.seed?.(seed);
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

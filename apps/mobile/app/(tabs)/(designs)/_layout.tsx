import { Stack } from "expo-router";
import { useTheme } from "../../../lib/theme";

/**
 * The tab's page first, under anything opened from it. Designs has the
 * system's see-through header, for its lockup and filter (designs.tsx),
 * as augmenter's board does.
 */
export const unstable_settings = { anchor: "designs" };

export default function Layout() {
  const { color } = useTheme();
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: color.bg },
        headerShadowVisible: false,
        headerTransparent: true,
        headerTitle: "",
        headerTintColor: color.ink,
        scrollEdgeEffects: { top: "soft" },
      }}
    />
  );
}

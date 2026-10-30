import { Stack } from "expo-router";
import { useTheme } from "../../../lib/theme";

/**
 * The tab's page first, under anything opened from it. Search shows the
 * system's header, its title where Designs has its lockup, and the
 * system's search field under it.
 */
export const unstable_settings = { anchor: "search" };

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

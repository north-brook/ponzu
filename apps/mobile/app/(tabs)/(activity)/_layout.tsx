import { Stack } from "expo-router";
import { useTheme } from "../../../lib/theme";

/**
 * The tab's page first, under anything opened from it. Activity has the
 * system's see-through header, its title where Designs has its lockup.
 */
export const unstable_settings = { anchor: "activity" };

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

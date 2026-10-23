import { Stack } from "expo-router";
import { useTheme } from "../../../lib/theme";

/**
 * The tab's page first, under anything opened from it. Search shows the
 * system's header, for the system's search field; it has no title.
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
      }}
    />
  );
}

import { Stack } from "expo-router";
import { useTheme } from "../../../lib/theme";

/** The tab's page first, under anything opened from it. */
export const unstable_settings = { anchor: "search" };

export default function Layout() {
  const { color } = useTheme();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />
  );
}

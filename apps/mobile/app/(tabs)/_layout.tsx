import { Stack } from "expo-router";

/** Designs, Search and Activity, each a stack of its own. */
export default function TabsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

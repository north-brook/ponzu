// Before anything that may load @ponzu/core.
import "../lib/polyfills";
import "../global.css";
import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { setBackgroundColorAsync } from "expo-system-ui";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { holdSplash } from "../lib/splash";
import { navigationTheme, useTheme } from "../lib/theme";

holdSplash();

/**
 * The root: system light or dark, gestures, and one stack. Fonts are
 * embedded in the binary (app.json's expo-font plugin), so nothing waits on
 * them. Screens draw their own safe areas; Expo Router provides the context.
 */
export default function RootLayout() {
  const { scheme, color } = useTheme();
  useEffect(() => {
    // The root view's color shows behind a sheet as it opens and while the
    // keyboard moves.
    setBackgroundColorAsync(color.bg);
  }, [color.bg]);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme(scheme)}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
          <Stack.Screen name="index" options={{ animation: "none" }} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

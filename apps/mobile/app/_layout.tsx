// Before anything that may load @ponzu/core.
import "../lib/polyfills";
import "../global.css";
import { Stack, ThemeProvider } from "expo-router";
import { hideAsync } from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { setBackgroundColorAsync } from "expo-system-ui";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { boot } from "../lib/boot";
import { QueryProvider } from "../lib/query";
import { useReachOnForeground } from "../lib/reach";
import { holdSplash } from "../lib/splash";
import { track } from "../lib/telemetry";
import { navigationTheme, useTheme } from "../lib/theme";

holdSplash();
boot();
track("app opened");

/**
 * The root: system light or dark, gestures, the keyboard's frame, and one stack. Fonts are
 * embedded in the binary (app.json's expo-font plugin), so nothing waits on
 * them. Screens draw their own safe areas; Expo Router provides the context.
 */
export default function RootLayout() {
  const { scheme, color } = useTheme();
  useReachOnForeground();
  // A deep link opens straight onto its screen; the launch screen hides the splash itself sooner.
  useEffect(() => {
    const t = setTimeout(() => hideAsync(), 400);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    // The root view's color shows behind a sheet as it opens and while the
    // keyboard moves.
    setBackgroundColorAsync(color.bg);
  }, [color.bg]);
  return (
    <QueryProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* The keyboard's frame on the UI thread, for sheets that ride it. */}
        <KeyboardProvider>
          <ThemeProvider value={navigationTheme(scheme)}>
            <StatusBar style="auto" />
            <Stack
              screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}
            >
              <Stack.Screen name="index" options={{ animation: "none" }} />
              <Stack.Screen
                name="connect/index"
                options={{ animation: "fade", gestureEnabled: false }}
              />
              <Stack.Screen
                name="connect/scan"
                options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
              />
              <Stack.Screen
                name="tailscale"
                options={{ animation: "fade", gestureEnabled: false }}
              />
              <Stack.Screen name="asleep" options={{ animation: "fade", gestureEnabled: false }} />
              <Stack.Screen name="designs" options={{ animation: "none", gestureEnabled: false }} />
              <Stack.Screen name="search" options={{ animation: "fade" }} />
              <Stack.Screen name="design/[mac]/[key]" options={{ animation: "default" }} />
              <Stack.Screen name="activity" options={{ animation: "default" }} />
              <Stack.Screen name="pair" options={{ animation: "none" }} />
              <Stack.Screen name="dev" options={{ animation: "none" }} />
            </Stack>
          </ThemeProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </QueryProvider>
  );
}

// Before anything that may load @ponzu/core or @ponzu/client.
import "../lib/polyfills";
import "../global.css";
import { Stack, ThemeProvider } from "expo-router";
import { hideAsync } from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { setBackgroundColorAsync } from "expo-system-ui";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Gate } from "../components/gate";
import { HandoffLayer } from "../components/handoff";
import { CloudProvider } from "../lib/cloud/query";
import { PingsProvider } from "../lib/push/pings";
import { holdSplash } from "../lib/splash";
import { track } from "../lib/telemetry";
import { navigationTheme, useTheme } from "../lib/theme";
import { useFirstLaunch } from "../lib/use-first-launch";
import { WindowInsetsProvider } from "../lib/window-insets";

holdSplash();
track("app opened");

/**
 * The root: system light or dark, gestures, the keyboard's frame, the signed-in person's client
 * state (lib/cloud/query.tsx), and one stack. Fonts are embedded in the binary (app.json's
 * expo-font plugin), so nothing waits on them. Screens draw their own safe areas; Expo Router
 * provides the context. Where the session sends the app is lib/cloud/use-gate.ts; where a tap on
 * a ping sends it, lib/push/pings.tsx.
 */
export default function RootLayout() {
  // A store build's first launch catches up to the current release behind the splash before
  // anything of the embedded one runs.
  const current = useFirstLaunch();
  const { scheme, color } = useTheme();
  // A deep link opens straight onto its screen; the launch screen hides the splash itself sooner.
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => hideAsync(), 400);
    return () => clearTimeout(t);
  }, [current]);
  useEffect(() => {
    // The root view's color shows behind a sheet as it opens and while the keyboard moves.
    setBackgroundColorAsync(color.bg);
  }, [color.bg]);
  if (!current) return null;
  return (
    <CloudProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* The keyboard's frame on the UI thread, for sheets that ride it. */}
        <KeyboardProvider>
          {/* The window's safe area, the rail at the side included, read above the tabs. */}
          <WindowInsetsProvider>
            <ThemeProvider value={navigationTheme(scheme)}>
              {/* Pings: taps, this phone's registration and the ask (lib/push/pings.tsx). */}
              <PingsProvider>
                <StatusBar style="auto" />
                <Gate />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: color.bg },
                  }}
                >
                  <Stack.Screen name="index" options={{ animation: "none" }} />
                  <Stack.Screen
                    name="sign-in"
                    options={{ animation: "fade", gestureEnabled: false }}
                  />
                  <Stack.Screen name="auth/callback" options={{ animation: "none" }} />
                  <Stack.Screen
                    name="update"
                    options={{ animation: "fade", gestureEnabled: false }}
                  />
                  {/* Setup: no way back to a step done, and the next one fades in over it. */}
                  <Stack.Screen
                    name="setup/where"
                    options={{ animation: "fade", gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="setup/claude"
                    options={{ animation: "fade", gestureEnabled: false }}
                  />
                  {/* Pasting claude.ai's code is a push from Connect Claude: back is Change. */}
                  <Stack.Screen name="setup/code" />
                  <Stack.Screen name="github/setup" options={{ animation: "none" }} />
                  <Stack.Screen
                    name="(tabs)"
                    options={{ animation: "none", gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="settings"
                    options={{
                      presentation: "formSheet",
                      sheetAllowedDetents: [0.5, 1],
                      sheetGrabberVisible: true,
                      contentStyle: { backgroundColor: color.bg },
                    }}
                  />
                  {/* The list's filter, a sheet from its header. */}
                  <Stack.Screen
                    name="filter"
                    options={{
                      presentation: "formSheet",
                      sheetAllowedDetents: [0.6, 1],
                      sheetGrabberVisible: true,
                      contentStyle: { backgroundColor: color.bg },
                    }}
                  />
                  {/* New canvas: a full screen pushed over the list; its picker, a sheet. */}
                  <Stack.Screen name="new" />
                  <Stack.Screen
                    name="pick-project"
                    options={{
                      presentation: "formSheet",
                      sheetAllowedDetents: [0.6, 1],
                      sheetGrabberVisible: true,
                      contentStyle: { backgroundColor: color.bg },
                    }}
                  />
                  {/* A canvas, pushed over the list; its own chrome floats over the boards. */}
                  <Stack.Screen
                    name="canvas/[id]"
                    options={{ contentStyle: { backgroundColor: color.canvas } }}
                  />
                  <Stack.Screen name="dev" options={{ animation: "none" }} />
                  <Stack.Screen name="+not-found" options={{ animation: "none" }} />
                </Stack>
                {/* The launch screen's yuzu and slice, carried into the first screen. */}
                <HandoffLayer />
              </PingsProvider>
            </ThemeProvider>
          </WindowInsetsProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </CloudProvider>
  );
}
